from app.application import create_app


# EdgeOne's Python scanner requires an explicit top-level app assignment.
app = create_app()

__all__ = ["app"]
