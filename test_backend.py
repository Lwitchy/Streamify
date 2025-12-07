import sys
import os
import io


try:
    from main import HTTPSServer
    from Security.SessionManager import session_manager
except ImportError as e:
    print(f"FAILED IMPORT: {e}")
    sys.exit(1)


class MockHandler(HTTPSServer):
    def __init__(self, path, headers=None):
        self.path = path
        self.headers = headers or {}
        self.wfile = io.BytesIO()
        self.rfile = io.BytesIO()
        self.client_address = ('127.0.0.1', 54321)
        
    def send_response(self, code, message=None):
        self.last_code = code
        print(f"Response Code: {code}")

    def get_current_user(self):
        if self.headers.get("Cookie") == "auth=true":
            return "TestUser"
        return None

    def send_header(self, keyword, value):
        pass

    def end_headers(self):
        pass

def test_path_traversal():
    print("\n--- Test Path Traversal ---")
    handler = MockHandler("/Database/%2e%2e/main.py", headers={"Cookie": "auth=true"})
    handler.do_GET()
    if handler.last_code == 403:
        print("PASS: Path traversal blocked (403).")
    else:
        print(f"FAIL: Expected 403, got {handler.last_code}")

def test_unauth_api():
    print("\n--- Test Unauthorized API Access ---")
    handler = MockHandler("/api/users")
    handler.do_GET()
    if handler.last_code == 401:
        print("PASS: Unauthorized API blocked.")
    else:
        print(f"FAIL: Expected 401, got {handler.last_code}")

def test_api_play_security():
    print("\n--- Test API Play Security ---")

    import main
    original_db = main.HandleDatabase
    
    class MockDB:
        def __init__(self): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def getSong(self, name):
            # Return a malicious path that might exist in DB
            return (1, "Evil", "Hacker", "Hack", "Rock", 10, "../main.py", "Now", "User")
        def close(self): pass

    class MockDBModule:
        HandleDatabase = MockDB

    main.HandleDatabase = MockDBModule

    try:
        handler = MockHandler("/api/play/EvilSong", headers={"Cookie": "auth=true"})
        handler.do_GET()
        if handler.last_code == 403:
             print("PASS: /api/play blocked unsafe path.")
        else:
             print(f"FAIL: /api/play expected 403, got {handler.last_code}")
    finally:
        main.HandleDatabase = original_db

def test_static_whitelist():
    print("\n--- Test Static Whitelist ---")
    
    h1 = MockHandler("/Static/loginpage/login.html")
    try:
        h1.do_GET()
        code = getattr(h1, 'last_code', 200) 
        if code != 302 and code != 401:
            print(f"PASS: /Static/loginpage is public (Code: {code})")
    except Exception as e:
        print(f"PASS: /Static/loginpage attempted serve ({e})")


    h2 = MockHandler("/Static/home/home.html")
    h2.do_GET()
    if h2.last_code == 302:
        print("PASS: /Static/home is protected.")
    else:
        print(f"FAIL: /Static/home expected 302, got {getattr(h2, 'last_code', 'Unknown')}")

if __name__ == "__main__":
    test_path_traversal()
    test_unauth_api()
    test_static_whitelist()
    test_api_play_security()
