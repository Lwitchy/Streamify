import time
import threading
from collections import defaultdict
import ipaddress

class RateLimiter:
    def __init__(self, max_attempts=5, window_seconds=60):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self._attempts = defaultdict(list)
        self._lock = threading.Lock()

    def _get_client_identifier(self, ip):
        """
        Normalize IP address. 
        Collapses IPv6 addresses to their /64 subnet to prevent rotation attacks.
        """
        try:
            addr = ipaddress.ip_address(ip)
            if isinstance(addr, ipaddress.IPv6Address):
                # Mask to /64
                network = ipaddress.IPv6Network(f"{ip}/64", strict=False)
                return str(network.network_address)
        except ValueError:
            pass
        return ip

    def is_blocked(self, ip):
        """Checks if the IP is currently blocked."""
        key = self._get_client_identifier(ip)
        now = time.time()
        with self._lock:
            # Filter out old attempts
            self._attempts[key] = [t for t in self._attempts[key] if now - t < self.window_seconds]
            
            if len(self._attempts[key]) >= self.max_attempts:
                return True
        return False

    def add_attempt(self, ip):
        """Records a failed attempt. Returns True if now blocked."""
        key = self._get_client_identifier(ip)
        now = time.time()
        with self._lock:
            # Clean first
            self._attempts[key] = [t for t in self._attempts[key] if now - t < self.window_seconds]
            
            # Add new failure
            self._attempts[key].append(now)
            
            return len(self._attempts[key]) >= self.max_attempts

    def reset(self, ip):
        """Resets the counter for an IP (e.g. on successful login)."""
        key = self._get_client_identifier(ip)
        with self._lock:
            if key in self._attempts:
                del self._attempts[key]

    def get_attempts(self, ip):
        key = self._get_client_identifier(ip)
        now = time.time()
        with self._lock:
             self._attempts[key] = [t for t in self._attempts[key] if now - t < self.window_seconds]
             return len(self._attempts[key])

# Global Instance
login_limiter = RateLimiter(max_attempts=5, window_seconds=300) # 5 attempts in 5 minutes
