"""Create a salted password hash for data/users.json.

    python tools/hash_password.py            # prompts (input hidden)
Paste the output as  "password_hash": "..."  and delete the plaintext "password" field.
"""
import getpass, sys
from werkzeug.security import generate_password_hash

pw = getpass.getpass("New password: ")
if len(pw) < 10:
    sys.exit("Use at least 10 characters.")
if pw != getpass.getpass("Repeat: "):
    sys.exit("Passwords do not match.")
print(generate_password_hash(pw))
