import threading
import time
import uuid

class SessionManager:
    def __init__(self, session_ttl=86400): # 24 hours
        self._sessions = {}
        self._lock = threading.Lock()
        self._ttl = session_ttl

    def create_session(self, username):
        """Creates a new session for the user and returns the session_id."""
        with self._lock:
            session_id = str(uuid.uuid4())
            self._sessions[session_id] = {
                'username': username,
                'created_at': time.time(),
                'last_accessed': time.time() # Added for sliding expiration capability
            }
            return session_id

    def get_user(self, session_id):
        """Returns the username for a valid session_id, or None if invalid/expired."""
        if not session_id:
            return None
            
        with self._lock:
            entry = self._sessions.get(session_id)
            if not entry:
                return None
            
            # Check expiration
            if time.time() - entry['created_at'] > self._ttl:
                del self._sessions[session_id]
                return None
            
            # Update last accessed (if we wanted sliding expiration, we'd check this instead of created_at)
            # For now keeping strict TTL based on creation to match original but cleaner
            entry['last_accessed'] = time.time()
            
            return entry['username']

    def remove_session(self, session_id):
        """Invalidates a session."""
        with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]

    def cleanup(self):
        """Removes all expired sessions."""
        now = time.time()
        with self._lock:
            expired = [sid for sid, data in self._sessions.items() if now - data['created_at'] > self._ttl]
            for sid in expired:
                del self._sessions[sid]

# Global Instance
session_manager = SessionManager()
