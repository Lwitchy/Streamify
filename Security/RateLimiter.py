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
        key = self._get_client_identifier(ip)
        now = time.time()
        with self._lock:
            self._attempts[key] = [t for t in self._attempts[key] if now - t < self.window_seconds]
            
            if len(self._attempts[key]) >= self.max_attempts:
                return True
        return False

    def add_attempt(self, ip):
        key = self._get_client_identifier(ip)
        now = time.time()
        with self._lock:
            self._attempts[key] = [t for t in self._attempts[key] if now - t < self.window_seconds]
            
            self._attempts[key].append(now)
            
            return len(self._attempts[key]) >= self.max_attempts

    def reset(self, ip):
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


class ApiRateLimiter:
    def __init__(self, limit=100, window=60):
        self.limit = limit          
        self.window = window        
        self.clients = defaultdict(list)

    def is_allowed(self, ip):
        current_time = time.time()
        request_times = self.clients[ip]
        

        request_times = [t for t in request_times if current_time - t < self.window]
        self.clients[ip] = request_times
        
        if len(request_times) >= self.limit:
            return False 

        self.clients[ip].append(current_time)
        return True

api_limiter = ApiRateLimiter(limit=60, window=60)
login_limiter = RateLimiter(max_attempts=5, window_seconds=300)
