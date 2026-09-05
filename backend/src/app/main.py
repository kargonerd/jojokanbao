"""Local ASGI entry point; the EdgeOne deployment uses api/index.py instead."""
from app.application import create_app


app = create_app()
