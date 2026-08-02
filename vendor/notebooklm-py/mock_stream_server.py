"""Mock streaming server for curl testing (no auth required)."""
import asyncio
import json


async def handle_stream(reader, writer):
    """Handle streaming request."""
    data = await reader.read(4096)
    request = data.decode('utf-8')
    
    if request.startswith('GET /stream'):
        query_start = request.find('question=')
        if query_start != -1:
            query_start += 9
            query_end = request.find(' ', query_start)
            question = request[query_start:query_end] if query_end != -1 else request[query_start:]
            question = question.replace('%20', ' ').replace('+', ' ').split('&')[0]
        else:
            question = "What is AI?"
        
        writer.write(b'HTTP/1.1 200 OK\r\n')
        writer.write(b'Content-Type: text/event-stream\r\n')
        writer.write(b'Cache-Control: no-cache\r\n')
        writer.write(b'Connection: keep-alive\r\n')
        writer.write(b'\r\n')
        await writer.drain()
        
        mock_answer = (
            "Machine learning is a subset of artificial intelligence (AI) "
            "that enables systems to learn and improve from experience without being "
            "explicitly programmed. It focuses on developing algorithms that can access "
            "data, learn from it, and make predictions or decisions."
        )
        
        words = mock_answer.split()
        chunk_size = 3
        
        for i in range(0, len(words), chunk_size):
            chunk_words = words[i:i + chunk_size]
            text = " ".join(chunk_words)
            if i > 0:
                text = " " + text
            
            payload = json.dumps({
                "text": text,
                "is_final": False,
                "conversation_id": "",
            }, ensure_ascii=False)
            writer.write(f"data: {payload}\n\n".encode('utf-8'))
            await writer.drain()
            await asyncio.sleep(0.1)
        
        final_payload = json.dumps({
            "text": "",
            "is_final": True,
            "conversation_id": "mock-conv-123",
        }, ensure_ascii=False)
        writer.write(f"data: {final_payload}\n\n".encode('utf-8'))
        await writer.drain()
    else:
        writer.write(b'HTTP/1.1 404 Not Found\r\n\r\n')
        await writer.drain()
    
    writer.close()
    await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle_stream, '127.0.0.1', 8765)
    print("=" * 50)
    print("Mock Streaming Server running at http://127.0.0.1:8765")
    print("=" * 50)
    print("\nTest with curl:")
    print('  curl "http://127.0.0.1:8765/stream?question=What+is+AI"')
    print("\nPress Ctrl+C to stop...")
    
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
