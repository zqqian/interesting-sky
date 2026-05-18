// 功能：Hexo 生成完成后，自动把 HTML 中 /images/ 开头的图片链接替换为 R2 图片子域名。

'use strict';

const fs = require('fs');
const path = require('path');

const IMAGE_CDN = 'https://img.interesting-sky.com';  // 改成你的 R2 自定义域名
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|bmp|webp|svg|tiff)$/i;

// 是否只替换 /images/ 目录下的图片。
// true：只替换 /images/xxx.webp
// false：替换所有以图片后缀结尾的站内绝对路径，例如 /2025/a.webp
const ONLY_IMAGES_DIR = true;

function walk(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      walk(fullPath, fileList);
    } else if (fullPath.endsWith('.html')) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

function shouldRewrite(url) {
  if (!url) return false;

  // 不处理已经是完整 URL 的链接
  if (/^(https?:)?\/\//i.test(url)) return false;

  // 不处理 data URI、mailto、tel、锚点
  if (/^(data:|mailto:|tel:|#)/i.test(url)) return false;

  // 只处理站内绝对路径
  if (!url.startsWith('/')) return false;

  // 是否限制在 /images/
  if (ONLY_IMAGES_DIR && !url.startsWith('/images/')) return false;

  // 去掉 query/hash 后判断扩展名
  const cleanPath = url.split(/[?#]/)[0];

  return IMAGE_EXT.test(cleanPath);
}

function rewriteUrl(url) {
  if (!shouldRewrite(url)) return url;
  return IMAGE_CDN.replace(/\/$/, '') + url;
}

function rewriteHtml(html) {
  // 替换 src="/images/xxx.webp"、href="/images/xxx.webp"、data-src="/images/xxx.webp" 等
  return html.replace(
    /\b(src|href|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi,
    function (match, attr, url) {
      const newUrl = rewriteUrl(url);
      return `${attr}="${newUrl}"`;
    }
  );
}

hexo.extend.filter.register('after_generate', function () {
  const publicDir = hexo.public_dir;
  const htmlFiles = walk(publicDir);

  let changedCount = 0;

  for (const file of htmlFiles) {
    const oldHtml = fs.readFileSync(file, 'utf8');
    const newHtml = rewriteHtml(oldHtml);

    if (newHtml !== oldHtml) {
      fs.writeFileSync(file, newHtml, 'utf8');
      changedCount += 1;
    }
  }

  hexo.log.info(`[R2 CDN] Rewrote image URLs in ${changedCount} HTML files.`);
});
