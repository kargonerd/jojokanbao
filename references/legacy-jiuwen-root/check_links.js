const http = require('http');
const fs = require('fs');

const url = 'http://localhost:8081/generate_stream?url=https://cn.nytimes.com/science/20260402/moon-nasa-artemis-launch/';

http.get(url, (res) => {
    let fullData = '';
    res.on('data', (chunk) => {
        const s = chunk.toString();
        fullData += s;
        // Print log events
        const lines = s.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const data = JSON.parse(line.substring(6));
                    if (data.text) {
                        process.stdout.write(data.text);
                    }
                } catch (e) {}
            }
        }
    });
    res.on('end', () => {
        console.log('\n[+] Stream finished.');
    });
}).on('error', (err) => {
    console.error('[!] HTTP Request Error: ' + err.message);
});