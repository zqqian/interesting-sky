const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const multer = require("multer"); // 添加 multer
const archiver = require("archiver"); // 添加 archiver 用于创建ZIP文件
const session = require("express-session"); // 添加 session 支持

const app = express();
const PORT = 3000;

// 配置 session
app.use(session({
    secret: 'your-secret-key', // 用于签名会话ID cookie的密钥
    resave: false, // 强制保存会话即使它没有被修改
    saveUninitialized: false, // 强制将未初始化的会话保存到存储中
    cookie: { 
        secure: false, // 如果为true，则仅通过HTTPS发送cookie
        maxAge: 3600000 // cookie有效期为1小时
    }
}));

// 配置 multer 用于文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // 按年月创建目录结构
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        
        // 创建图片目录结构 images/YYYY/MM
        const dir = path.join(__dirname, "public/images", String(year), month);
        
        // 确保目录存在
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        
        cb(null, dir); // 上传文件保存路径
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + ext); // 使用时间戳作为文件名避免冲突
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 限制文件大小为5MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        }
        cb(new Error("只支持图片格式（jpeg/jpg/png/gif）"));
    }
});

app.use(bodyParser.json());

// 中间件：检查用户是否已登录
const checkAuth = (req, res, next) => {
    // 检查session中的认证状态
    if (req.session.isAuthenticated) {
        next(); // 已认证，继续处理请求
    } else {
        // 未认证，重定向到登录页面
        res.redirect('/login.html');
    }
};

// 保护admin目录下的所有请求（包括静态文件）
app.use('/admin', (req, res, next) => {
    // 如果是登录请求，直接通过
    if (req.path === '/login' && req.method === 'POST') {
        return next();
    }
    
    // 其他admin路径需要验证
    checkAuth(req, res, next);
});

// 静态文件服务 - 放在认证中间件之后
app.use(express.static("public"));

// 创建上传目录（如果不存在）
const uploadDir = path.join(__dirname, "public/images");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 创建一个 SSE 客户端集合
const clients = [];

// 管理员登录路由
app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    
    // 这里设置管理员密码，实际应用中应该使用加密存储的密码
    const adminPassword = "admin123"; // 请修改为更安全的密码
    
    if (password === adminPassword) {
        // 登录成功，设置session
        req.session.isAuthenticated = true;
        res.json({ success: true });
    } else {
        // 登录失败
        res.status(401).json({ success: false, message: "密码错误" });
    }
});

// 登出路由
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// 检查认证状态的路由
app.get('/admin/check-auth', (req, res) => {
    if (req.session.isAuthenticated) {
        res.status(200).json({ authenticated: true });
    } else {
        res.status(401).json({ authenticated: false });
    }
});

// SSE 连接处理
app.get('/progress-stream', (req, res) => {
    // 设置 SSE 所需的头信息
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // 发送初始消息
    res.write(`data: ${JSON.stringify({progress: 0, message: '准备开始生成...'})}\n\n`);
    
    // 将此客户端添加到客户端集合
    clients.push(res);
    
    // 客户端断开连接时从集合中移除
    req.on('close', () => {
        const index = clients.indexOf(res);
        if (index !== -1) {
            clients.splice(index, 1);
        }
    });
});

// 向所有客户端发送进度更新
function sendProgressUpdate(progress, message) {
    const data = JSON.stringify({ progress, message });
    clients.forEach(client => {
        client.write(`data: ${data}\n\n`);
    });
}

// API: 保存 Markdown 文件
app.post("/save", (req, res) => {
    const { filename, content } = req.body;
    if (!filename || !content) {
        return res.status(400).send("Filename and content are required.");
    }

    const filePath = path.join(__dirname, "source/_posts", `${filename}.md`);
    fs.writeFileSync(filePath, content, "utf8");

    res.send("Markdown saved!");
});

// API: 获取 Markdown 文件内容
app.get("/file", (req, res) => {
    const filename = req.query.name;
    if (!filename) {
        return res.status(400).send("Filename is required.");
    }

    const filePath = path.join(__dirname, "source/_posts", `${filename}.md`);
    
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf8");
            res.json({ content });
        } else {
            res.status(404).send("File not found.");
        }
    } catch (error) {
        res.status(500).send(`Error reading file: ${error.message}`);
    }
});

// 全局变量，用于缓存文件列表
let cachedFiles = null;
let lastCacheTime = null;

// 从Markdown内容中提取日期
function extractDateFromContent(content) {
    // 尝试从YAML front matter中提取date字段
    const dateMatch = content.match(/---[\s\S]*?date:\s*([^\n\r]+)[\s\S]*?---/);
    
    if (dateMatch && dateMatch[1]) {
        // 尝试解析日期
        try {
            let dateStr = dateMatch[1].trim();
            
            // 如果日期被单引号或双引号包围，去除引号
            dateStr = dateStr.replace(/^['"]|['"]$/g, '');
            
            const date = new Date(dateStr);
            
            if (!isNaN(date.getTime())) {
                return date;
            } else {
                console.log('无效日期');
            }
        } catch (e) {
            console.error('解析日期出错:', e);
        }
    }
    // 如果无法提取或解析日期，返回null
    console.log('无法提取日期，返回null');
    return null;
}

// 获取所有文章文件
app.get("/files", (req, res) => {
    // 检查是否有缓存且缓存未过期（10分钟）
    const useCache = !req.query.refresh && cachedFiles && lastCacheTime && 
                    (Date.now() - lastCacheTime < 10 * 60 * 1000);
    
    if (useCache) {
        // 返回缓存的文件列表
        return res.json({
            files: cachedFiles,
            cached: true,
            lastCacheTime: lastCacheTime
        });
    }
    
    const postsDir = path.join(__dirname, "source/_posts");
    
    fs.readdir(postsDir, (err, files) => {
        if (err) {
            console.error("读取文件夹出错:", err);
            return res.status(500).json({ error: "读取文件夹出错" });
        }
        
        // 过滤出.md文件
        const mdFiles = files.filter(file => file.endsWith(".md"));
        const fileDetails = [];
        
        // 使用Promise.all处理所有文件
        Promise.all(
            mdFiles.map(filename => {
                return new Promise((resolve, reject) => {
                    const filePath = path.join(postsDir, filename);
                    
                    fs.stat(filePath, (err, stats) => {
                        if (err) {
                            console.error(`获取文件信息出错 ${filename}:`, err);
                            return resolve(null); // 跳过出错的文件
                        }
                        
                        fs.readFile(filePath, 'utf8', (err, content) => {
                            if (err) {
                                console.error(`读取文件出错 ${filename}:`, err);
                                return resolve(null); // 跳过出错的文件
                            }
                            
                            // 提取标题
                            const titleMatch = content.match(/title:\s*(.+)/);
                            const title = titleMatch ? titleMatch[1].trim() : filename;
                            
                            // 提取文章日期
                            const articleDate = extractDateFromContent(content);
                            
                            resolve({
                                filename,
                                title,
                                lastModified: stats.mtime,
                                articleDate: articleDate || stats.mtime, // 如果无法提取日期，使用文件修改时间
                                size: stats.size
                            });
                        });
                    });
                });
            })
        )
        .then(results => {
            // 过滤掉null值并按文章日期排序（降序）
            const validResults = results.filter(result => result !== null);
            validResults.sort((a, b) => new Date(b.articleDate) - new Date(a.articleDate));
            
            // 更新缓存
            cachedFiles = validResults;
            lastCacheTime = Date.now();
            
            res.json({
                files: validResults,
                cached: false,
                lastCacheTime: lastCacheTime
            });
        })
        .catch(error => {
            console.error("处理文件列表出错:", error);
            res.status(500).json({ error: "处理文件列表出错" });
        });
    });
});

// 刷新文件列表（带进度更新）
app.get("/refresh-files", (req, res) => {
    // 设置SSE响应头
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    // 发送初始消息
    res.write(`data: ${JSON.stringify({ progress: 0, message: "开始刷新文章列表..." })}\n\n`);
    
    const postsDir = path.join(__dirname, "source/_posts");
    
    fs.readdir(postsDir, (err, files) => {
        if (err) {
            console.error("读取文件夹出错:", err);
            res.write(`data: ${JSON.stringify({ progress: -1, message: `读取文件夹出错: ${err.message}` })}\n\n`);
            return res.end();
        }
        
        // 过滤出.md文件
        const mdFiles = files.filter(file => file.endsWith(".md"));
        const totalFiles = mdFiles.length;
        
        if (totalFiles === 0) {
            res.write(`data: ${JSON.stringify({ progress: 100, message: "没有找到Markdown文件" })}\n\n`);
            
            // 更新缓存
            cachedFiles = [];
            lastCacheTime = Date.now();
            
            return res.end();
        }
        
        res.write(`data: ${JSON.stringify({ progress: 5, message: `找到 ${totalFiles} 个Markdown文件，开始处理...` })}\n\n`);
        
        const fileDetails = [];
        let processedCount = 0;
        
        // 处理每个文件
        mdFiles.forEach(filename => {
            const filePath = path.join(postsDir, filename);
            
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error(`获取文件信息出错 ${filename}:`, err);
                    res.write(`data: ${JSON.stringify({ progress: -1, message: `获取文件信息出错 ${filename}: ${err.message}` })}\n\n`);
                    processedCount++;
                    return;
                }
                
                fs.readFile(filePath, 'utf8', (err, content) => {
                    processedCount++;
                    const progress = Math.floor((processedCount / totalFiles) * 90) + 5; // 5% - 95%
                    
                    if (err) {
                        console.error(`读取文件出错 ${filename}:`, err);
                        res.write(`data: ${JSON.stringify({ progress: progress, message: `读取文件出错 ${filename}: ${err.message}` })}\n\n`);
                    } else {
                        // 提取标题
                        const titleMatch = content.match(/title:\s*(.+)/);
                        const title = titleMatch ? titleMatch[1].trim() : filename;
                        
                        // 提取文章日期
                        const articleDate = extractDateFromContent(content);
                        
                        fileDetails.push({
                            filename,
                            title,
                            lastModified: stats.mtime,
                            articleDate: articleDate || stats.mtime,
                            size: stats.size
                        });
                        
                        res.write(`data: ${JSON.stringify({ progress: progress, message: `处理文件 ${processedCount}/${totalFiles}: ${filename}` })}\n\n`);
                    }
                    
                    // 检查是否所有文件都已处理
                    if (processedCount === totalFiles) {
                        // 按文章日期排序（降序）
                        fileDetails.sort((a, b) => new Date(b.articleDate) - new Date(a.articleDate));
                        
                        // 更新缓存
                        cachedFiles = fileDetails;
                        lastCacheTime = Date.now();
                        
                        res.write(`data: ${JSON.stringify({ progress: 100, message: `完成! 已处理 ${fileDetails.length} 个文件` })}\n\n`);
                        res.end();
                    }
                });
            });
        });
    });
});

// 处理POST请求到/refresh-files（触发刷新）
app.post("/refresh-files", (req, res) => {
    res.json({ message: "刷新请求已接收" });
});

// API: 删除文章
app.delete("/file/:filename", (req, res) => {
    let filename = req.params.filename;
    if (!filename) {
        return res.status(400).send("Filename is required.");
    }
    
    // 检查文件名是否已经包含.md后缀
    const hasExtension = filename.toLowerCase().endsWith('.md');
    const filePath = path.join(__dirname, "source/_posts", hasExtension ? filename : `${filename}.md`);
    
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true, message: "文件已成功删除" });
        } else {
            res.status(404).send("File not found.");
        }
    } catch (error) {
        res.status(500).send(`Error deleting file: ${error.message}`);
    }
});

// API: 生成HTML
app.post("/generate", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.status(200).send("Started generation process");
    
    // 获取是否需要先清理
    const cleanFirst = req.body.cleanFirst || false;
    // 获取是否需要创建ZIP
    const createZip = req.body.createZip || false;
    
    // 记录生成前的文件状态
    let beforeFiles = [];
    if (createZip) {
        try {
            // 检查整个public目录而不仅仅是public/post
            const publicDir = path.join(__dirname, "public");
            if (fs.existsSync(publicDir)) {
                beforeFiles = getFilesWithStats(publicDir);
                // 只保留HTML文件
                beforeFiles = beforeFiles.filter(file => file.relativePath.endsWith('.html'));
            }
        } catch (error) {
            console.error("获取生成前文件状态失败:", error);
        }
    }
    
    // 如果需要先清理
    if (cleanFirst) {
        sendProgressUpdate(5, "正在清理缓存...");
        
        // 使用 spawn 代替 exec 以便获取实时输出
        const cleanProcess = spawn("hexo", ["clean"], { cwd: __dirname });
        
        // 处理标准输出
        cleanProcess.stdout.on('data', (data) => {
            sendProgressUpdate(8, data.toString().trim());
        });
        
        // 处理标准错误
        cleanProcess.stderr.on('data', (data) => {
            sendProgressUpdate(8, `警告: ${data.toString().trim()}`);
        });
        
        // 命令完成处理
        cleanProcess.on('close', (code) => {
            if (code === 0) {
                sendProgressUpdate(10, "清理缓存完成，开始生成...");
                executeGenerate(createZip, beforeFiles);
            } else {
                sendProgressUpdate(-1, `清理缓存失败，错误代码: ${code}`);
            }
        });
    } else {
        // 直接执行generate
        executeGenerate(createZip, beforeFiles);
    }
    
    // 执行hexo generate的函数
    function executeGenerate(createZip, beforeFiles) {
        // 使用 spawn 代替 exec 以便获取实时输出
        const hexoProcess = spawn("hexo", ["generate"], { cwd: __dirname });
        
        let output = '';
        let progressValue = 10;
        
        // 处理标准输出
        hexoProcess.stdout.on('data', (data) => {
            output += data.toString();
            // 根据输出内容更新进度
            progressValue += 5;
            if (progressValue > 90) progressValue = 90;
            
            sendProgressUpdate(progressValue, data.toString().trim());
        });
        
        // 处理标准错误
        hexoProcess.stderr.on('data', (data) => {
            output += data.toString();
            sendProgressUpdate(progressValue, `警告: ${data.toString().trim()}`);
        });
        
        // 命令完成处理
        hexoProcess.on('close', (code) => {
            if (code === 0) {
                if (createZip) {
                    sendProgressUpdate(95, "生成完成！正在创建变更文章ZIP包...");
                    // 获取生成后的文件状态
                    let afterFiles = [];
                    try {
                        // 检查整个public目录而不仅仅是public/post
                        const publicDir = path.join(__dirname, "public");
                        if (fs.existsSync(publicDir)) {
                            afterFiles = getFilesWithStats(publicDir);
                            // 只保留HTML文件
                            afterFiles = afterFiles.filter(file => file.relativePath.endsWith('.html'));
                        }
                    } catch (error) {
                        console.error("获取生成后文件状态失败:", error);
                        sendProgressUpdate(-1, `获取文件变化失败: ${error.message}`);
                        return;
                    }
                    
                    // 找出变化的文件
                    const changedFiles = findChangedFiles(beforeFiles, afterFiles);
                    
                    if (changedFiles.length === 0) {
                        sendProgressUpdate(100, "生成完成！没有发现文章变化，无需创建ZIP包。");
                    } else {
                        // 创建新文章的ZIP文件
                        createArticlesZip(changedFiles).then(zipPath => {
                            sendProgressUpdate(100, `生成完成！变更文章ZIP包已创建：${path.basename(zipPath)}，共包含${changedFiles.length}个文件。`);
                        }).catch(error => {
                            sendProgressUpdate(-1, `创建ZIP包失败: ${error.message}`);
                        });
                    }
                } else {
                    sendProgressUpdate(100, "生成完成！");
                }
            } else {
                sendProgressUpdate(-1, `生成失败，错误代码: ${code}`);
            }
        });
    }
});

// 创建新文章的ZIP文件
async function createArticlesZip(files) {
    const publicDir = path.join(__dirname, "public");
    const zipDir = path.join(__dirname, "public/downloads");
    const zipFilename = `articles_${Date.now()}.zip`;
    const zipPath = path.join(zipDir, zipFilename);
    
    // 确保下载目录存在
    if (!fs.existsSync(zipDir)) {
        fs.mkdirSync(zipDir, { recursive: true });
    }
    
    // 创建写入流
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
        zlib: { level: 9 } // 最高压缩级别
    });
    
    // 设置事件处理
    return new Promise((resolve, reject) => {
        output.on('close', () => {
            resolve(zipPath);
        });
        
        archive.on('error', (err) => {
            reject(err);
        });
        
        // 将输出流连接到归档
        archive.pipe(output);
        
        // 添加变化的文件到归档
        files.forEach(file => {
            const filePath = file.path;
            const relativePath = file.relativePath;
            archive.file(filePath, { name: relativePath });
        });
        
        // 完成归档
        archive.finalize();
    });
}

// 获取目录中所有文件及其状态信息
function getFilesWithStats(dir, fileList = [], baseDir = null) {
    if (!baseDir) baseDir = dir;
    
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            // 递归处理子目录
            getFilesWithStats(filePath, fileList, baseDir);
        } else {
            // 添加文件信息
            fileList.push({
                path: filePath,
                relativePath: path.relative(baseDir, filePath),
                size: stat.size,
                mtime: stat.mtime.getTime()
            });
        }
    }
    
    return fileList;
}

// 找出两次扫描之间变化的文件
function findChangedFiles(beforeFiles, afterFiles) {
    const changedFiles = [];
    const beforeMap = new Map();
    
    // 创建之前文件的映射
    beforeFiles.forEach(file => {
        beforeMap.set(file.relativePath, file);
    });
    
    // 检查每个新文件
    afterFiles.forEach(afterFile => {
        const beforeFile = beforeMap.get(afterFile.relativePath);
        
        // 如果文件是新增的或者已修改的
        if (!beforeFile || beforeFile.size !== afterFile.size || beforeFile.mtime !== afterFile.mtime) {
            changedFiles.push(afterFile);
        }
    });
    
    return changedFiles;
}

// API: 获取最新的ZIP文件
app.get("/latest-articles-zip", (req, res) => {
    const zipDir = path.join(__dirname, "public/downloads");
    
    // 如果目录不存在，返回错误
    if (!fs.existsSync(zipDir)) {
        return res.status(404).json({ error: "没有可用的ZIP文件" });
    }
    
    // 获取目录中的所有文件
    const files = fs.readdirSync(zipDir)
        .filter(file => file.endsWith('.zip') && file.startsWith('articles_'))
        .map(file => {
            const filePath = path.join(zipDir, file);
            return {
                name: file,
                path: filePath,
                time: fs.statSync(filePath).mtime.getTime()
            };
        })
        .sort((a, b) => b.time - a.time); // 按修改时间降序排序
    
    // 如果没有ZIP文件，返回错误
    if (files.length === 0) {
        return res.status(404).json({ error: "没有可用的ZIP文件" });
    }
    
    // 返回最新的ZIP文件信息
    res.json({
        filename: files[0].name,
        url: `/downloads/${files[0].name}`
    });
});

// API: 上传图片
app.post("/upload", upload.single("image"), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send("No file uploaded.");
        }
        
        // 获取文件的相对路径（相对于public目录）
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        
        // 构建相对路径格式: images/YYYY/MM/filename
        const relativePath = `/images/${year}/${month}/${req.file.filename}`;
        
        res.json({ url: relativePath });
    } catch (error) {
        res.status(400).send(error.message);
    }
});

// Git Pull SSE 客户端集合
const gitPullClients = [];

// Git Pull 进度流
app.get('/git-pull-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // 发送初始消息
    res.write('data: {"progress": 0, "message": "连接成功，等待操作..."}\n\n');
    
    // 将客户端添加到集合
    gitPullClients.push(res);
    
    // 客户端断开连接时从集合中移除
    req.on('close', () => {
        const index = gitPullClients.indexOf(res);
        if (index !== -1) {
            gitPullClients.splice(index, 1);
        }
    });
});

// 向所有Git Pull客户端发送进度更新
function sendGitPullUpdate(progress, message) {
    const data = JSON.stringify({ progress, message });
    gitPullClients.forEach(client => {
        client.write(`data: ${data}\n\n`);
    });
}

// API: 执行Git Pull操作
app.post("/git-pull", (req, res) => {
    // 立即响应请求
    res.send("Git Pull 过程已开始，请查看进度条");
    
    // 发送开始消息
    sendGitPullUpdate(10, "开始执行 Git Pull...");
    
    // 使用spawn执行git pull命令
    const gitProcess = spawn("git", ["pull"], { cwd: __dirname });
    
    let output = '';
    let progressValue = 20;
    
    // 处理标准输出
    gitProcess.stdout.on('data', (data) => {
        output += data.toString();
        // 根据输出内容更新进度
        progressValue += 20;
        if (progressValue > 80) progressValue = 80;
        
        sendGitPullUpdate(progressValue, data.toString().trim());
    });
    
    // 处理标准错误
    gitProcess.stderr.on('data', (data) => {
        output += data.toString();
        // Git的一些信息也会输出到stderr，但不一定是错误
        sendGitPullUpdate(progressValue, data.toString().trim());
    });
    
    // 命令完成处理
    gitProcess.on('close', (code) => {
        if (code === 0) {
            sendGitPullUpdate(100, "Git Pull 完成！");
        } else {
            sendGitPullUpdate(-1, `Git Pull 失败，错误代码: ${code}`);
        }
    });
});

// Git Commit & Push SSE 客户端集合
const gitPushClients = [];

// Git Commit & Push 进度流
app.get('/git-push-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // 发送初始消息
    res.write('data: {"progress": 0, "message": "连接成功，等待操作..."}\n\n');
    
    // 将客户端添加到集合
    gitPushClients.push(res);
    
    // 客户端断开连接时从集合中移除
    req.on('close', () => {
        const index = gitPushClients.indexOf(res);
        if (index !== -1) {
            gitPushClients.splice(index, 1);
        }
    });
});

// 向所有Git Push客户端发送进度更新
function sendGitPushUpdate(progress, message) {
    const data = JSON.stringify({ progress, message });
    gitPushClients.forEach(client => {
        client.write(`data: ${data}\n\n`);
    });
}

// API: 执行Git Commit & Push操作
app.post("/git-push", (req, res) => {
    // 获取提交信息
    const commitMessage = req.body.message || "更新博客内容";
    
    // 立即响应请求
    res.send("Git Commit & Push 过程已开始，请查看进度条");
    
    // 发送开始消息
    sendGitPushUpdate(5, "开始执行 Git Commit & Push...");
    
    // 使用spawn执行git add命令
    sendGitPushUpdate(10, "执行 git add .");
    const gitAddProcess = spawn("git", ["add", "."], { cwd: __dirname });
    
    let progressValue = 10;
    
    // 处理git add完成
    gitAddProcess.on('close', (addCode) => {
        if (addCode !== 0) {
            sendGitPushUpdate(-1, `Git add 失败，错误代码: ${addCode}`);
            return;
        }
        
        progressValue = 30;
        sendGitPushUpdate(progressValue, "Git add 完成，执行 git commit");
        
        // 执行git commit
        const gitCommitProcess = spawn("git", ["commit", "-m", commitMessage], { cwd: __dirname });
        
        // 处理标准输出
        gitCommitProcess.stdout.on('data', (data) => {
            sendGitPushUpdate(progressValue, data.toString().trim());
        });
        
        // 处理标准错误
        gitCommitProcess.stderr.on('data', (data) => {
            sendGitPushUpdate(progressValue, data.toString().trim());
        });
        
        // 处理git commit完成
        gitCommitProcess.on('close', (commitCode) => {
            // 如果没有变更，git commit会返回非零值，但这不一定是错误
            if (commitCode !== 0) {
                // 检查是否是"nothing to commit"的情况
                if (progressValue === 30) { // 如果进度值没有变化，说明没有输出消息
                    sendGitPushUpdate(progressValue, "没有变更需要提交，跳过commit步骤");
                    progressValue = 60;
                    proceedWithPush();
                } else {
                    sendGitPushUpdate(-1, `Git commit 失败，错误代码: ${commitCode}`);
                }
                return;
            }
            
            progressValue = 60;
            sendGitPushUpdate(progressValue, "Git commit 完成，执行 git push");
            proceedWithPush();
        });
        
        // 执行git push
        function proceedWithPush() {
            const gitPushProcess = spawn("git", ["push"], { cwd: __dirname });
            
            // 处理标准输出
            gitPushProcess.stdout.on('data', (data) => {
                progressValue = 80;
                sendGitPushUpdate(progressValue, data.toString().trim());
            });
            
            // 处理标准错误
            gitPushProcess.stderr.on('data', (data) => {
                // Git push的进度信息通常输出到stderr
                const output = data.toString().trim();
                if (output.includes("Writing objects:") || output.includes("remote:")) {
                    progressValue = Math.min(90, progressValue + 5);
                }
                sendGitPushUpdate(progressValue, output);
            });
            
            // 处理git push完成
            gitPushProcess.on('close', (pushCode) => {
                if (pushCode === 0) {
                    sendGitPushUpdate(100, "Git push 完成！所有操作已成功完成。");
                } else {
                    sendGitPushUpdate(-1, `Git push 失败，错误代码: ${pushCode}`);
                }
            });
        }
    });
    
    // 处理git add的输出
    gitAddProcess.stdout.on('data', (data) => {
        sendGitPushUpdate(progressValue, data.toString().trim());
    });
    
    gitAddProcess.stderr.on('data', (data) => {
        sendGitPushUpdate(progressValue, data.toString().trim());
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});