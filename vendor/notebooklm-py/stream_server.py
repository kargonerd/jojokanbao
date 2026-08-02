"""Simple HTTP server to test ask_stream with curl."""
import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from notebooklm import NotebookLMClient

NOTEBOOK_ID = "YOUR_NOTEBOOK_ID"  # 替换成你的 notebook ID


async def handle_stream(reader, writer):
    """Handle streaming request."""
    data = await reader.read(4096)
    request = data.decode('utf-8')
    
    if request.startswith('GET /stream?question='):
        query_start = request.find('question=') + 9
        query_end = request.find(' ', query_start)
        question = request[query_start:query_end]
        question = question.replace('%20', ' ').replace('+', ' ')
        
        writer.write(b'HTTP/1.1 200 OK\r\n')
        writer.write(b'Content-Type: text/event-stream\r\n')
        writer.write(b'Cache-Control: no-cache\r\n')
        writer.write(b'Connection: keep-alive\r\n')
        writer.write(b'\r\n')
        await writer.drain()
        
        try:
            async with NotebookLMClient.from_storage() as client:
                async for chunk in client.chat.ask_stream(NOTEBOOK_ID, question):
                    payload = json.dumps({
                        "text": chunk.text,
                        "is_final": chunk.is_final,
                        "conversation_id": chunk.conversation_id,
                    }, ensure_ascii=False)
                    writer.write(f"data: {payload}\n\n".encode('utf-8'))
                    await writer.drain()
        except Exception as e:
            error_msg = json.dumps({"error": str(e)})
            writer.write(f"data: {error_msg}\n\n".encode('utf-8'))
            await writer.drain()
    else:
        writer.write(b'HTTP/1.1 404 Not Found\r\n\r\n')
        await writer.drain()
    
    writer.close()
    await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle_stream, '127.0.0.1', 8765)
    print("Server running on http://127.0.0.1:8765")
    print("\nTest with curl:")
    print('  curl "http://127.0.0.1:8765/stream?question=What+is+AI"')
    print("\nPress Ctrl+C to stop...")
    
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
