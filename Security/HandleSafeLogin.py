from urllib.parse import parse_qs


def checkUser(data, db):
    print("checkUser talking to you! data: ", data)


    parsed_data = parse_qs(data.decode("utf-8"))
    username = parsed_data.get("username", [None])[0]
    password = parsed_data.get("password", [None])[0]

    if not username or not password:
        return False
    
    user = db.getUser(username)
    if user and user[2] == password:
        return True
    
    return False
