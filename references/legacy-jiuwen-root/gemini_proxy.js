const http = require('http');
const { exec } = require('child_process');

const server = http.createServer((req, res) => {
    // 设置 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/generate') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'URL is required' }));
                    return;
                }

                console.log(`[+] 收到请求，准备处理 URL: ${url}`);
                
                // 这里的指令非常明确：抓取 -> 搜索 -> 总结 -> 输出 HTML
                const prompt = `你是一个资深新闻编辑。请访问这个新闻链接：${url} ，如果需要可以使用工具抓取正文。然后，提炼事件核心，去搜索至少2篇与该事件相关的历史新闻（比如延期记录、几年前的相反声明、或是行业背景）。最后，请把“当前新闻”和“历史新闻”进行对比，指出态度的变化或承诺的落空，并直接生成一段漂亮的 HTML 代码（可以带 Tailwind 类名）来展示这个“合订本”时间线。要求：只输出 HTML 代码，不要包含 \`\`\`html 标记，不要输出其他闲聊废话。`;

                const cmd = `gemini --prompt "${prompt.replace(/"/g, '\\"')}" -y`;
                console.log(`[+] 正在拉起 Gemini CLI (YOLO 模式)... 这可能需要1-2分钟`);

                // 使用 YOLO 模式 (-y) 让它自动批准工具调用，从而在后台跑完
                exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                    console.log(`[+] Gemini CLI 执行完毕`);
                    if (error) {
                        console.error(`[!] 执行错误: ${error}`);
                        res.writeHead(500);
                        res.end(JSON.stringify({ html: `<div class="p-4 bg-red-100 text-red-700 rounded-lg">处理失败，请查看命令行日志。错误: ${error.message}</div>` }));
                        return;
                    }

                    // 简单清理下可能的 Markdown 标记
                    let result = stdout.replace(/```html/g, '').replace(/```/g, '').trim();
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ html: result }));
                });
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(8081, () => {
    console.log('==================================================');
    console.log('🚀 Gemini CLI 代理服务已启动，监听在 http://localhost:8081');
    console.log('🚀 现在你可以在 http://localhost:8080/dynamic_demo.html 里随便填入链接了！');
    console.log('==================================================');
});
