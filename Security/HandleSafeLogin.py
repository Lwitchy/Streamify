from urllib.parse import parse_qs
import bcrypt


def checkUser(data, db):
    print("checkUser talking to you! data: ", data)


    parsed_data = parse_qs(data.decode("utf-8"))
    username = parsed_data.get("username", [None])[0]
    password = parsed_data.get("password", [None])[0]

    if not isinstance(username, str) or not isinstance(password, str):
        return False

    if not username or not password:
        return False


    user = db.getUser(username)

    if not user:
        return False
    
    stored_hash = user[2]
    password_bytes = password.encode("utf-8")

    return bcrypt.checkpw(password_bytes, stored_hash)