const { spawn } = require('child_process');
const p = spawn('gemini.cmd', ['-p', 'test prompt', '-y'], { shell: false });
p.stdout.on('data', d => console.log(d.toString()));
p.stderr.on('data', d => console.error('err', d.toString()));
p.on('close', c => console.log('code', c));