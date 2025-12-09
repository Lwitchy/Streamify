from Logic.HandleDatabase import HandleDatabase
import bcrypt

username = input("Enter username: ")
password = input("Enter password: ")

hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

HandleDatabase().insertUser(username, hashed_password, "admin")