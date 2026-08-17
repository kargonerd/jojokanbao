"""Minimal local search service for Reader/Agent end-to-end checks."""
from __future__ import annotations

from flask import Flask, jsonify, request
from flask_cors import CORS

from content_search import search_content


app = Flask(__name__)
CORS(app, origins=["http://127.0.0.1:5173", "http://localhost:5173"])


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/content/search")
def content_search_route():
    try:
        return jsonify(search_content(request.get_json(silent=True) or {}))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


if __name__ == "__main__":
    app.run(port=9000, host="127.0.0.1", debug=False)
