const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HTML_FILE = path.join(__dirname, 'dynamic_demo.html');

// Frontend Server (Port 8080)
const frontendServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/dynamic_demo.html') {
        fs.readFile(HTML_FILE, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading dynamic_demo.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

frontendServer.listen(8080, () => {
    console.log('✅ 前端页面已启动: http://localhost:8080/dynamic_demo.html');
});

// 读取 hook 捕获的所有搜索结果
function readSearchResults() {
    const cumulativeFile = path.join(__dirname, '.gemini', 'search-results-all.json');
    
    try {
        if (fs.existsSync(cumulativeFile)) {
            const content = fs.readFileSync(cumulativeFile, 'utf-8');
            const allResults = JSON.parse(content);
            
            // 合并所有搜索结果的 llmContent
            const combinedContent = allResults.map(r => {
                const llmContent = r.data?.tool_response?.llmContent || '';
                return `【搜索: ${r.query}】\n${llmContent}`;
            }).join('\n\n---\n\n');
            
            return combinedContent;
        }
    } catch (err) {
        console.error(`[!] 读取搜索结果失败: ${err.message}`);
    }
    
    return null;
}

// 清理之前的搜索结果文件
function clearSearchResults() {
    const cumulativeFile = path.join(__dirname, '.gemini', 'search-results-all.json');
    try {
        if (fs.existsSync(cumulativeFile)) {
            fs.unlinkSync(cumulativeFile);
        }
    } catch (err) {
        console.error(`[!] 清理搜索结果失败: ${err.message}`);
    }
}

// 生成时间线 HTML
function generateTimelineHTML(entityName, entityType, timelineData) {
    if (!timelineData || timelineData.length === 0) {
        return `<div class="max-w-2xl mx-auto p-6 bg-white shadow-lg rounded-lg">
            <h2 class="text-2xl font-bold mb-6 text-gray-800">${entityName} - 时间线</h2>
            <p class="text-gray-600">未能提取到时间线数据</p>
        </div>`;
    }

    const items = timelineData.map((item, index) => {
        const hasSource = item.source && item.source !== '[Link Missing]' && !item.source.includes('vertexaisearch');
        const sourceLink = hasSource 
            ? `<a href="${item.source}" target="_blank" class="inline-block mt-2 text-sm text-blue-500 hover:underline">查看来源</a>`
            : '';
        
        return `
    <div class="mb-8 ml-6">
      <div class="absolute w-4 h-4 bg-blue-500 rounded-full -left-[9px] border-2 border-white"></div>
      <time class="text-sm font-semibold text-blue-600 uppercase tracking-wide">${item.date || '未知日期'}</time>
      <h3 class="text-lg font-bold text-gray-900 mt-1">${item.title || '无标题'}</h3>
      <p class="text-gray-600 mt-2 leading-relaxed">${item.description || ''}</p>
      ${sourceLink}
    </div>`;
    }).join('\n');

    return `<div class="max-w-2xl mx-auto p-6 bg-white shadow-lg rounded-lg">
  <h2 class="text-2xl font-bold mb-6 text-gray-800 border-b pb-2">${entityName} - 历史时间线</h2>
  <div class="relative border-l-2 border-blue-500 ml-3">
    ${items}
  </div>
  <div class="mt-6 pt-4 border-t text-sm text-gray-500">
    共 ${timelineData.length} 个时间节点 | 类型: ${entityType}
  </div>
</div>`;
}

// 使用 Gemini CLI 抽取实体
async function extractEntities(htmlContent, url) {
    return new Promise((resolve, reject) => {
        const prompt = `请分析以下新闻内容，抽取关键实体（人名、机构、政策、事件、概念等）。

【新闻URL】
${url}

【新闻内容】
${htmlContent.substring(0, 10000)}

【任务要求】
1. 识别新闻中提到的所有重要实体
2. 对每个实体，给出：
   - 实体名称
   - 实体类型（人名/机构/政策/事件/概念/其他）
   - 一句话描述该实体在新闻中的角色
   - 推荐理由（为什么这个实体值得追溯历史）
3. 按重要性排序，最多返回8个实体
4. 输出格式必须是JSON数组

【输出格式示例】
[
  {
    "name": "张雪峰",
    "type": "人名",
    "description": "教育网红，因考研指导走红",
    "reason": "其个人职业生涯和争议历史值得追溯"
  },
  {
    "name": "高考志愿填报",
    "type": "政策/制度",
    "description": "中国教育体系中的大学专业选择机制",
    "reason": "该政策的历史变迁反映教育改革"
  }
]

【要求】
- 只输出JSON数组，不要其他文字
- 确保JSON格式正确`;

        const child = spawn('gemini', ['-p', '-', '--approval-mode', 'yolo'], { shell: true });
        let output = '';

        child.stdin.write(prompt);
        child.stdin.end();

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.on('close', (code) => {
            console.log(`[+] 实体抽取完成，退出码: ${code}`);
            
            // 尝试从输出中提取JSON
            try {
                const jsonMatch = output.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const entities = JSON.parse(jsonMatch[0]);
                    resolve(entities);
                } else {
                    resolve([]);
                }
            } catch (err) {
                console.error(`[!] 解析实体JSON失败: ${err.message}`);
                resolve([]);
            }
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

// 使用 Gemini CLI 执行搜索
async function searchWithGemini(query) {
    return new Promise((resolve, reject) => {
        // 清理之前的搜索结果
        const latestFile = path.join(__dirname, '.gemini', 'search-results-latest.json');
        if (fs.existsSync(latestFile)) {
            fs.unlinkSync(latestFile);
        }

        const searchPrompt = `请使用 google_web_search 工具搜索以下内容："${query}"

要求：
1. 搜索该主题的历史新闻、官方声明、重要事件
2. 尽可能找到最早的相关报道（从互联网有记录开始）
3. 按时间顺序整理所有关键事件
4. 确保返回每个搜索结果的真实 URL（Source URI）`;

        console.log(`[+] 启动 Gemini CLI 进行搜索...`);
        
        const child = spawn('gemini', ['-p', '-', '--approval-mode', 'yolo'], { 
            shell: true,
            cwd: __dirname
        });
        
        let output = '';
        let stderr = '';

        child.stdin.write(searchPrompt);
        child.stdin.end();

        child.stdout.on('data', (data) => {
            output += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            console.log(`[+] Gemini CLI 搜索完成，退出码: ${code}`);
            
            const searchResults = readSearchResults();
            
            resolve({ 
                output, 
                stderr, 
                code,
                searchResults
            });
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

// Backend API Server (Port 8081)
const backendServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    // API: 抽取实体
    if (pathname === '/extract_entities' && req.method === 'GET') {
        const targetUrl = urlObj.searchParams.get('url');

        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'URL is required' }));
            return;
        }

        console.log(`[+] 收到实体抽取请求: ${targetUrl}`);

        // 抓取网页
        fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.text();
        })
        .then(async htmlContent => {
            // 提取标题
            const titleMatch = htmlContent.match(/<title[^>]*>([^<]*)<\/title>/i);
            const title = titleMatch ? titleMatch[1].trim() : '';

            // 抽取实体
            const entities = await extractEntities(htmlContent, targetUrl);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                title,
                url: targetUrl,
                entities
            }));
        })
        .catch(error => {
            console.error(`[!] 实体抽取失败: ${error}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        });

        return;
    }

    // API: 生成合订本（根据选择的实体）
    if (pathname === '/generate_stream' && req.method === 'GET') {
        const targetUrl = urlObj.searchParams.get('url');
        const entityName = urlObj.searchParams.get('entity');
        const entityType = urlObj.searchParams.get('type') || '未知';

        if (!targetUrl || !entityName) {
            res.writeHead(400);
            res.end('URL and entity are required');
            return;
        }

        console.log(`[+] 收到生成请求，实体: ${entityName} (${entityType})`);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // 抓取网页
        fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.text();
        })
        .then(async htmlContent => {
            const maxLength = 10000;
            const truncatedHtml = htmlContent.length > maxLength ? htmlContent.substring(0, maxLength) + '...(truncated)' : htmlContent;

            res.write(`event: log\ndata: ${JSON.stringify({ text: `[SYSTEM] 开始追溯实体: ${entityName}\n` })}\n\n`);

            // 清理之前的搜索结果
            clearSearchResults();

            // 让 Gemini CLI 自己执行多次搜索来搜集历史
            console.log(`[+] 启动 Gemini CLI 自主搜索历史: ${entityName}`);
            res.write(`event: log\ndata: ${JSON.stringify({ text: `[SYSTEM] 让 AI 自主搜索 "${entityName}" 的历史...\n` })}\n\n`);

            const searchPrompt = `你是一个研究助手。请为"${entityName}"（类型：${entityType}）搜集完整的历史资料。

任务：
1. 调用 google_web_search 工具，搜索该实体的历史信息
2. 根据搜索结果，判断是否需要进一步搜索其他相关关键词
3. 多次调用搜索工具，尽可能覆盖该实体的完整历史（从最早出现到现在）
4. 整理所有搜索结果，按时间顺序排列

输出要求：
1. 展示你调用的所有搜索查询
2. 列出所有搜索结果的标题、日期、来源和URL
3. 按时间顺序整理关键事件
4. 确保每个事件都有对应的来源链接

请开始搜索。`;

            const searchChild = spawn('gemini', ['-p', '-', '--approval-mode', 'yolo'], { 
                shell: true,
                cwd: __dirname
            });
            
            let searchOutput = '';

            searchChild.stdin.write(searchPrompt);
            searchChild.stdin.end();

            searchChild.stdout.on('data', (data) => {
                const text = data.toString();
                searchOutput += text;
                res.write(`event: log\ndata: ${JSON.stringify({ text }) }\n\n`);
            });

            searchChild.stderr.on('data', (data) => {
                const text = data.toString();
                res.write(`event: log\ndata: ${JSON.stringify({ text }) }\n\n`);
            });

            await new Promise((resolve) => {
                searchChild.on('close', (code) => {
                    console.log(`[+] 自主搜索完成，退出码: ${code}`);
                    resolve();
                });
            });

            // 读取 hook 捕获的所有搜索结果
            const searchResults = readSearchResults();
            
            if (!searchResults) {
                res.write(`event: log\ndata: ${JSON.stringify({ text: '[WARNING] 未能获取搜索结果，使用输出内容...\n' })}\n\n`);
            }

            const combinedSearchResults = searchResults || searchOutput;
            
            console.log(`[+] 搜索阶段完成`);
            res.write(`event: log\ndata: ${JSON.stringify({ text: '[SYSTEM] 搜索阶段完成，整理结构化数据...\n' })}\n\n`);

            // 第二阶段：让 Gemini 提取结构化时间线数据（JSON格式）
            const extractPrompt = `基于以下搜索结果，提取完整的时间线数据，输出JSON格式。

【搜索结果】
${combinedSearchResults}

【任务】
1. 从搜索结果中提取所有时间节点
2. 每个节点包含：
   - date: 日期（如"2021年5月13日"）
   - title: 事件标题
   - description: 事件描述
   - source: 来源URL（必须从【搜索结果】的Sources部分复制真实链接）
3. 按时间顺序排列
4. 只输出JSON数组，不要其他文字

【重要】来源URL获取方法：
- 每个搜索结果末尾都有"Sources:"部分
- 格式如：[1] domain.com (https://vertexaisearch.cloud.google.com/grounding-api-redirect/...)
- 你必须复制括号内的完整URL作为source字段
- 严禁编造链接！

【输出格式示例】
[
  {
    "date": "2021年5月13日",
    "title": "苏州峰学蔚来教育科技有限公司正式成立",
    "description": "张雪峰宣布离开北京迁往苏州...",
    "source": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/..."
  }
]`;

            console.log(`[+] 正在提取结构化数据...`);
            res.write(`event: log\ndata: ${JSON.stringify({ text: '[SYSTEM] 正在提取结构化时间线数据...\n' })}\n\n`);

            const extractChild = spawn('gemini', ['-p', '-', '--approval-mode', 'yolo'], { shell: true });
            let extractOutput = "";

            extractChild.stdin.write(extractPrompt);
            extractChild.stdin.end();

            extractChild.stdout.on('data', (data) => {
                const text = data.toString();
                extractOutput += text;
            });

            extractChild.stderr.on('data', (data) => {
                const text = data.toString();
                res.write(`event: log\ndata: ${JSON.stringify({ text }) }\n\n`);
            });

            extractChild.on('close', async (code) => {
                console.log(`[+] 数据提取完成，退出码: ${code}`);
                
                // 解析JSON
                let timelineData = [];
                try {
                    const jsonMatch = extractOutput.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        timelineData = JSON.parse(jsonMatch[0]);
                        console.log(`[+] 提取到 ${timelineData.length} 个时间节点`);
                        res.write(`event: log\ndata: ${JSON.stringify({ text: `[SYSTEM] 提取到 ${timelineData.length} 个时间节点\n` })}\n\n`);
                    }
                } catch (err) {
                    console.error(`[!] 解析时间线数据失败: ${err.message}`);
                    res.write(`event: log\ndata: ${JSON.stringify({ text: `[WARNING] 解析数据失败，使用原始输出\n` })}\n\n`);
                }

                // 用代码生成HTML
                const result = generateTimelineHTML(entityName, entityType, timelineData);
                
                // 验证链接
                console.log(`[+] 开始验证链接...`);
                res.write(`event: log\ndata: ${JSON.stringify({ text: '[SYSTEM] 开始验证链接有效性...\n' })}\n\n`);
                
                try {
                    const validationResults = await validateLinks(result);
                    const validLinks = validationResults.filter(r => r.ok).length;
                    const totalLinks = validationResults.length;
                    const invalidLinks = validationResults.filter(r => !r.ok);
                    
                    console.log(`[+] 链接验证完成: ${validLinks}/${totalLinks} 个链接有效`);
                    res.write(`event: log\ndata: ${JSON.stringify({ text: `[SYSTEM] 链接验证完成: ${validLinks}/${totalLinks} 个链接有效\n` })}\n\n`);
                    
                    if (invalidLinks.length > 0) {
                        console.log(`[!] 发现 ${invalidLinks.length} 个无效链接`);
                        res.write(`event: log\ndata: ${JSON.stringify({ text: `[WARNING] 发现 ${invalidLinks.length} 个无效链接:\n` })}\n\n`);
                        invalidLinks.forEach(link => {
                            res.write(`event: log\ndata: ${JSON.stringify({ text: `  - ${link.url}\n` })}\n\n`);
                        });
                    }
                } catch (err) {
                    console.log(`[!] 链接验证过程出错: ${err.message}`);
                }

                res.write(`event: result\ndata: ${JSON.stringify({ html: result })}\n\n`);
                res.end();
            });

            extractChild.on('error', (error) => {
                console.error(`[!] 执行错误: ${error}`);
                res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
                res.end();
            });
        })
        .catch(error => {
            console.error(`[!] 网页抓取失败: ${error}`);
            res.write(`event: error\ndata: ${JSON.stringify({ message: '网页抓取失败: ' + error.message })}\n\n`);
            res.end();
        });

        return;
    }

    res.writeHead(404);
    res.end();
});

// 链接验证函数
async function validateLinks(html) {
    const urlRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    const urls = [];
    let match;
    while ((match = urlRegex.exec(html)) !== null) {
        urls.push(match[1]);
    }
    
    const results = [];
    for (const url of urls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(url, {
                method: 'HEAD',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            clearTimeout(timeoutId);
            results.push({ url, status: response.status, ok: response.ok });
        } catch (error) {
            results.push({ url, status: 'ERROR', ok: false, error: error.message });
        }
    }
    
    return results;
}

backendServer.listen(8081, () => {
    console.log('✅ 后端代理已启动: http://localhost:8081/generate_stream');
    console.log('✅ 实体抽取API: http://localhost:8081/extract_entities?url=...');
});
