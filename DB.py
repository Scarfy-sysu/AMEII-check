# DB.py
import datetime
import os
import sqlite3

ACTION_SIGN_IN = "\u7b7e\u5230"
ACTION_SIGN_OUT = "\u7b7e\u9000"

class DB:
    def __init__(self, db_path=None):
        self.db_path = db_path or os.getenv("DB_PATH", "./face_database.db")
        self.conn = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
        self.cursor = self.conn.cursor()
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS faces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT,
                created_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                feature BLOB NOT NULL,
                image BLOB NOT NULL
            )
        ''')
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('签到', '签退')),
                event_time DATETIME NOT NULL,
                duration_seconds INTEGER
            )
        ''')
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS pending_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                name TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('签到', '签退')),
                detected_time DATETIME NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'rejected', 'superseded')),
                reason TEXT,
                created_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        self.cursor.execute('''
            CREATE TABLE IF NOT EXISTS external_sync_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                attendance_id INTEGER,
                pending_id INTEGER,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                action TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'success', 'failed')),
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_retry_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_http_status INTEGER,
                last_response TEXT,
                last_error TEXT,
                created_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        face_columns = {row[1] for row in self.cursor.execute("PRAGMA table_info(faces)").fetchall()}
        if "email" not in face_columns:
            self.cursor.execute("ALTER TABLE faces ADD COLUMN email TEXT")
        columns = {row[1] for row in self.cursor.execute("PRAGMA table_info(attendance)").fetchall()}
        if "duration_seconds" not in columns:
            self.cursor.execute("ALTER TABLE attendance ADD COLUMN duration_seconds INTEGER")
        self.cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_attendance_name_time ON attendance(name, event_time DESC, id DESC)"
        )
        self.cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_pending_source_status ON pending_actions(source, status, id DESC)"
        )
        self.cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_status_retry ON external_sync_jobs(status, next_retry_time, id)"
        )
        self.conn.commit()

    def tensor_to_bytes(self, tensor):
        import numpy as np
        import torch

        if tensor.dim() > 1:
            tensor = tensor.squeeze()
        np_array = tensor.detach().cpu().numpy() if isinstance(tensor, torch.Tensor) else tensor
        return np_array.tobytes()

    def bytes_to_tensor(self, bytes_data):
        import numpy as np
        import torch

        np_array = np.frombuffer(bytes_data, dtype=np.float32).copy()
        return torch.from_numpy(np_array).reshape(1, -1)

    def insert(self, name, feature, image, ext, email=None):
        import cv2

        feature_bytes = self.tensor_to_bytes(feature)
        success, image_bytes = cv2.imencode(ext, image)
        if not success:
            raise ValueError("图像编码失败")
        created_time = datetime.datetime.now()
        self.cursor.execute('''
            INSERT INTO faces (name, email, created_time, feature, image)
            VALUES (?, ?, ?, ?, ?)
        ''', (name, email, created_time, feature_bytes, image_bytes))
        self.conn.commit()

    def select_features(self):
        rows = self.cursor.execute("SELECT name, feature FROM faces").fetchall()
        features = {}
        for name, feature in rows:
            features.setdefault(name, []).append(self.bytes_to_tensor(feature))
        return features

    # ===== 新增：列表/取图/改名/删除 =====
    def list_all(self):
        rows = self.cursor.execute("SELECT id, name, email, created_time FROM faces ORDER BY id DESC").fetchall()
        return rows  # list of tuples

    def get_face_email_by_name(self, name):
        row = self.cursor.execute(
            "SELECT email FROM faces WHERE name=? ORDER BY id DESC LIMIT 1",
            (name,),
        ).fetchone()
        if not row:
            return None
        return (row[0] or "").strip() or None

    def get_image_by_id(self, rec_id):
        import cv2
        import numpy as np

        row = self.cursor.execute("SELECT image FROM faces WHERE id=?", (rec_id,)).fetchone()
        if not row:
            return None
        image_bytes = row[0]
        img_np = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(img_np, cv2.IMREAD_COLOR)
        return img

    def update_name(self, rec_id, new_name, legacy_names=None):
        new_name = (new_name or "").strip()
        if not new_name:
            raise ValueError("name required")

        row = self.cursor.execute("SELECT name FROM faces WHERE id=?", (rec_id,)).fetchone()
        if not row:
            raise ValueError("face not found")
        old_name = (row[0] or "").strip()

        aliases = set()
        aliases.add(old_name)
        if legacy_names:
            for item in legacy_names:
                v = (item or "").strip()
                if v:
                    aliases.add(v)
        aliases.discard(new_name)

        self.cursor.execute("UPDATE faces SET name=? WHERE id=?", (new_name, rec_id))
        face_self_count = self.cursor.rowcount if self.cursor.rowcount is not None else 0

        faces_alias_count = 0
        attendance_count = 0
        pending_count = 0
        sync_jobs_count = 0

        for alias in aliases:
            self.cursor.execute("UPDATE faces SET name=? WHERE name=?", (new_name, alias))
            faces_alias_count += self.cursor.rowcount if self.cursor.rowcount is not None else 0

            self.cursor.execute("UPDATE attendance SET name=? WHERE name=?", (new_name, alias))
            attendance_count += self.cursor.rowcount if self.cursor.rowcount is not None else 0

            self.cursor.execute("UPDATE pending_actions SET name=? WHERE name=?", (new_name, alias))
            pending_count += self.cursor.rowcount if self.cursor.rowcount is not None else 0

            self.cursor.execute("UPDATE external_sync_jobs SET name=? WHERE name=?", (new_name, alias))
            sync_jobs_count += self.cursor.rowcount if self.cursor.rowcount is not None else 0

        self.conn.commit()
        return {
            "old_name": old_name,
            "new_name": new_name,
            "updated": {
                "face_self": face_self_count,
                "faces_alias": faces_alias_count,
                "attendance": attendance_count,
                "pending_actions": pending_count,
                "external_sync_jobs": sync_jobs_count,
            },
        }

    def update_email(self, rec_id, new_email):
        self.cursor.execute("UPDATE faces SET email=? WHERE id=?", (new_email, rec_id))
        self.conn.commit()

    def delete_by_id(self, rec_id):
        self.cursor.execute("DELETE FROM faces WHERE id=?", (rec_id,))
        self.conn.commit()

    # ===== 考勤记录 =====
    @staticmethod
    def _assert_action(action):
        if action not in ("签到", "签退"):
            raise ValueError(f"非法动作: {action}")

    @staticmethod
    def _to_datetime(value):
        if isinstance(value, datetime.datetime):
            return value
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        try:
            return datetime.datetime.fromisoformat(text)
        except ValueError:
            pass
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.datetime.strptime(text, fmt)
            except ValueError:
                continue
        return None

    def get_last_attendance(self, name):
        row = self.cursor.execute(
            """
            SELECT action, event_time
            FROM attendance
            WHERE name=?
            ORDER BY event_time DESC, id DESC
            LIMIT 1
            """,
            (name,),
        ).fetchone()
        return row  # (action, event_time) or None

    def validate_attendance_transition(self, name, action):
        self._assert_action(action)
        last = self.get_last_attendance(name)
        if action == "签到":
            if last and last[0] == "签到":
                return False, "当前已签到，请勿重复签到"
            return True, ""

        # action == "签退"
        if not last:
            return False, "还没有签到记录，不能签退"
        if last[0] != "签到":
            return False, "上一状态为签退，请先签到"
        return True, ""

    def _last_signin_before(self, name, event_dt):
        row = self.cursor.execute(
            """
            SELECT event_time
            FROM attendance
            WHERE name=? AND action=? AND event_time<=?
            ORDER BY event_time DESC, id DESC
            LIMIT 1
            """,
            (name, ACTION_SIGN_IN, event_dt),
        ).fetchone()
        if not row:
            return None
        return self._to_datetime(row[0])

    def insert_attendance(self, name, action, event_time=None):
        self._assert_action(action)
        if event_time is None:
            event_time = datetime.datetime.now()
        event_dt = self._to_datetime(event_time) or datetime.datetime.now()
        duration_seconds = None
        if action == "签退":
            signin_dt = self._last_signin_before(name, event_dt)
            if signin_dt is not None and event_dt >= signin_dt:
                duration_seconds = int((event_dt - signin_dt).total_seconds())
        self.cursor.execute(
            '''
            INSERT INTO attendance (name, action, event_time, duration_seconds)
            VALUES (?, ?, ?, ?)
            ''',
            (name, action, event_dt, duration_seconds),
        )
        self.conn.commit()
        return {
            "id": self.cursor.lastrowid,
            "duration_seconds": duration_seconds,
        }

    def list_attendance(self, limit=500):
        try:
            limit = int(limit)
        except Exception:
            limit = 500
        if limit <= 0:
            limit = 500
        rows = self.cursor.execute(
            """
            SELECT id, name, action, event_time, duration_seconds
            FROM attendance
            ORDER BY event_time DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return rows

    def list_attendance_recent(self, days=3, limit=500, now_time=None):
        try:
            days = int(days)
        except Exception:
            days = 3
        if days <= 0:
            days = 3
        try:
            limit = int(limit)
        except Exception:
            limit = 500
        if limit <= 0:
            limit = 500
        now_dt = self._to_datetime(now_time) or datetime.datetime.now()
        cutoff = now_dt - datetime.timedelta(days=days)
        rows = self.cursor.execute(
            """
            SELECT id, name, action, event_time, duration_seconds
            FROM attendance
            WHERE event_time >= ?
            ORDER BY event_time DESC, id DESC
            LIMIT ?
            """,
            (cutoff, limit),
        ).fetchall()
        return rows

    def list_overdue_signed_in_users(self, overdue_before, limit=200):
        try:
            limit = int(limit)
        except Exception:
            limit = 200
        if limit <= 0:
            limit = 200
        cutoff = self._to_datetime(overdue_before) or datetime.datetime.now()
        rows = self.cursor.execute(
            """
            SELECT a.name, a.event_time
            FROM attendance a
            JOIN (
                SELECT name, MAX(id) AS max_id
                FROM attendance
                GROUP BY name
            ) last ON last.max_id = a.id
            WHERE a.action=? AND a.event_time <= ?
            ORDER BY a.event_time ASC, a.id ASC
            LIMIT ?
            """,
            (ACTION_SIGN_IN, cutoff, limit),
        ).fetchall()
        return rows

    def list_overdue_signed_in_entries(self, overdue_before, limit=200):
        try:
            limit = int(limit)
        except Exception:
            limit = 200
        if limit <= 0:
            limit = 200
        cutoff = self._to_datetime(overdue_before) or datetime.datetime.now()
        rows = self.cursor.execute(
            """
            SELECT a.id, a.name, a.event_time
            FROM attendance a
            JOIN (
                SELECT name, MAX(id) AS max_id
                FROM attendance
                GROUP BY name
            ) last ON last.max_id = a.id
            WHERE a.action=? AND a.event_time <= ?
            ORDER BY a.event_time ASC, a.id ASC
            LIMIT ?
            """,
            (ACTION_SIGN_IN, cutoff, limit),
        ).fetchall()
        return rows

    def get_overdue_signed_in_entry_for_name(self, name, overdue_before):
        cutoff = self._to_datetime(overdue_before) or datetime.datetime.now()
        row = self.cursor.execute(
            """
            SELECT id, action, event_time
            FROM attendance
            WHERE name=?
            ORDER BY event_time DESC, id DESC
            LIMIT 1
            """,
            (name,),
        ).fetchone()
        if not row:
            return None
        rid, action, event_time = row
        if action != ACTION_SIGN_IN:
            return None
        dt = self._to_datetime(event_time)
        if dt is None or dt > cutoff:
            return None
        return rid, dt

    def delete_attendance_by_id(self, attendance_id):
        self.cursor.execute("DELETE FROM attendance WHERE id=?", (attendance_id,))
        deleted = self.cursor.rowcount if self.cursor.rowcount is not None else 0
        self.conn.commit()
        return int(deleted)

    def supersede_pending_actions_for_name(self, name, reason="session_invalidated"):
        now = datetime.datetime.now()
        self.cursor.execute(
            """
            UPDATE pending_actions
            SET status='superseded', reason=?, updated_time=?
            WHERE name=? AND status='pending'
            """,
            (reason, now, name),
        )
        updated = self.cursor.rowcount if self.cursor.rowcount is not None else 0
        self.conn.commit()
        return int(updated)

    def invalidate_overdue_signin_by_id(self, attendance_id, name, reason="session_invalidated"):
        now = datetime.datetime.now()
        self.cursor.execute("DELETE FROM attendance WHERE id=?", (attendance_id,))
        deleted = self.cursor.rowcount if self.cursor.rowcount is not None else 0
        self.cursor.execute(
            """
            UPDATE pending_actions
            SET status='superseded', reason=?, updated_time=?
            WHERE name=? AND status='pending'
            """,
            (reason, now, name),
        )
        superseded = self.cursor.rowcount if self.cursor.rowcount is not None else 0
        self.conn.commit()
        return {
            "deleted_attendance": int(deleted),
            "superseded_pending": int(superseded),
        }

    def delete_attendance_before(self, cutoff_time):
        cutoff = self._to_datetime(cutoff_time) or datetime.datetime.now()
        self.cursor.execute("DELETE FROM attendance WHERE event_time < ?", (cutoff,))
        deleted = self.cursor.rowcount if self.cursor.rowcount is not None else 0
        self.conn.commit()
        return int(deleted)

    # ===== 待确认动作 =====
    def upsert_pending_action(self, source, name, action, detected_time=None):
        self._assert_action(action)
        if not source:
            source = "cam1"
        det_dt = self._to_datetime(detected_time) or datetime.datetime.now()

        row = self.cursor.execute(
            """
            SELECT id, name, action
            FROM pending_actions
            WHERE source=? AND status='pending'
            ORDER BY id DESC
            LIMIT 1
            """,
            (source,),
        ).fetchone()

        if row and row[1] == name and row[2] == action:
            self.cursor.execute(
                """
                UPDATE pending_actions
                SET detected_time=?, updated_time=?
                WHERE id=?
                """,
                (det_dt, datetime.datetime.now(), row[0]),
            )
            self.conn.commit()
            return row[0]

        if row:
            self.cursor.execute(
                """
                UPDATE pending_actions
                SET status='superseded', updated_time=?
                WHERE id=?
                """,
                (datetime.datetime.now(), row[0]),
            )

        self.cursor.execute(
            """
            INSERT INTO pending_actions (source, name, action, detected_time, status, updated_time)
            VALUES (?, ?, ?, ?, 'pending', ?)
            """,
            (source, name, action, det_dt, datetime.datetime.now()),
        )
        self.conn.commit()
        return self.cursor.lastrowid

    def list_pending_actions(self, source=None, limit=50):
        try:
            limit = int(limit)
        except Exception:
            limit = 50
        if limit <= 0:
            limit = 50

        if source:
            rows = self.cursor.execute(
                """
                SELECT id, source, name, action, detected_time, status
                FROM pending_actions
                WHERE status='pending' AND source=?
                ORDER BY detected_time DESC, id DESC
                LIMIT ?
                """,
                (source, limit),
            ).fetchall()
        else:
            rows = self.cursor.execute(
                """
                SELECT id, source, name, action, detected_time, status
                FROM pending_actions
                WHERE status='pending'
                ORDER BY detected_time DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return rows

    def get_pending_action_by_id(self, pending_id):
        row = self.cursor.execute(
            """
            SELECT id, source, name, action, detected_time, status
            FROM pending_actions
            WHERE id=?
            """,
            (pending_id,),
        ).fetchone()
        return row

    def create_external_sync_job(self, attendance_id, pending_id, name, email, action):
        now = datetime.datetime.now()
        self.cursor.execute(
            """
            INSERT INTO external_sync_jobs
            (attendance_id, pending_id, name, email, action, status, attempt_count, next_retry_time, updated_time)
            VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
            """,
            (attendance_id, pending_id, name, email, action, now, now),
        )
        self.conn.commit()
        return self.cursor.lastrowid

    def get_sync_job_by_id(self, job_id):
        row = self.cursor.execute(
            """
            SELECT id, attendance_id, pending_id, name, email, action, attempt_count
            FROM external_sync_jobs
            WHERE id=?
            """,
            (job_id,),
        ).fetchone()
        return row

    def list_retryable_sync_jobs(self, limit=20):
        try:
            limit = int(limit)
        except Exception:
            limit = 20
        if limit <= 0:
            limit = 20
        now = datetime.datetime.now()
        rows = self.cursor.execute(
            """
            SELECT id, attendance_id, pending_id, name, email, action, attempt_count
            FROM external_sync_jobs
            WHERE status='pending' AND next_retry_time<=?
            ORDER BY id ASC
            LIMIT ?
            """,
            (now, limit),
        ).fetchall()
        return rows

    def list_sync_jobs(self, limit=100):
        try:
            limit = int(limit)
        except Exception:
            limit = 100
        if limit <= 0:
            limit = 100
        rows = self.cursor.execute(
            """
            SELECT id, attendance_id, pending_id, name, email, action, status, attempt_count,
                   next_retry_time, last_http_status, last_response, last_error, created_time, updated_time
            FROM external_sync_jobs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return rows

    def mark_sync_job_success(self, job_id, http_status=None, response_text=None):
        self.cursor.execute(
            """
            UPDATE external_sync_jobs
            SET status='success',
                attempt_count=attempt_count+1,
                last_http_status=?,
                last_response=?,
                last_error=NULL,
                updated_time=?
            WHERE id=?
            """,
            (http_status, response_text, datetime.datetime.now(), job_id),
        )
        self.conn.commit()

    def mark_sync_job_retry(self, job_id, delay_seconds, http_status=None, response_text=None, error_text=None):
        delay_seconds = max(1, int(delay_seconds))
        next_retry = datetime.datetime.now() + datetime.timedelta(seconds=delay_seconds)
        self.cursor.execute(
            """
            UPDATE external_sync_jobs
            SET status='pending',
                attempt_count=attempt_count+1,
                next_retry_time=?,
                last_http_status=?,
                last_response=?,
                last_error=?,
                updated_time=?
            WHERE id=?
            """,
            (next_retry, http_status, response_text, error_text, datetime.datetime.now(), job_id),
        )
        self.conn.commit()

    def mark_sync_job_failed(self, job_id, http_status=None, response_text=None, error_text=None):
        self.cursor.execute(
            """
            UPDATE external_sync_jobs
            SET status='failed',
                attempt_count=attempt_count+1,
                last_http_status=?,
                last_response=?,
                last_error=?,
                updated_time=?
            WHERE id=?
            """,
            (http_status, response_text, error_text, datetime.datetime.now(), job_id),
        )
        self.conn.commit()

    def confirm_pending_action(self, pending_id, confirm_time=None):
        row = self.cursor.execute(
            """
            SELECT id, source, name, action, detected_time, status
            FROM pending_actions
            WHERE id=?
            """,
            (pending_id,),
        ).fetchone()
        if not row:
            return False, "待确认记录不存在", None
        if row[5] != "pending":
            return False, f"当前状态为 {row[5]}，不能确认", None

        _id, _source, name, action, detected_time, _status = row
        ok, reason = self.validate_attendance_transition(name, action)
        if not ok:
            return False, reason, None

        event_dt = self._to_datetime(confirm_time) or datetime.datetime.now()
        att = self.insert_attendance(name, action, event_dt)

        self.cursor.execute(
            """
            UPDATE pending_actions
            SET status='confirmed', updated_time=?
            WHERE id=?
            """,
            (datetime.datetime.now(), pending_id),
        )
        self.conn.commit()
        return True, "确认成功", att

    def reject_pending_action(self, pending_id, reason="人工驳回"):
        row = self.cursor.execute(
            "SELECT status FROM pending_actions WHERE id=?",
            (pending_id,),
        ).fetchone()
        if not row:
            return False, "待确认记录不存在"
        if row[0] != "pending":
            return False, f"当前状态为 {row[0]}，不能驳回"
        self.cursor.execute(
            """
            UPDATE pending_actions
            SET status='rejected', reason=?, updated_time=?
            WHERE id=?
            """,
            (reason, datetime.datetime.now(), pending_id),
        )
        self.conn.commit()
        return True, "已驳回"

    def close(self):
        self.conn.close()
