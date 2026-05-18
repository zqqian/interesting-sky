// 功能：在 Hexo 渲染 HTML 时，自动把站内图片链接改写为 Cloudflare R2 图片域名。
// 例如：/images/a.webp -> https://img.interesting-sky.com/images/a.webp

'use strict';

hexo.log.info('[R2 CDN] r2-image-cdn.js loaded');

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|bmp|webp|svg|tiff|avif)([?#].*)?$/i;

function normalizeCdn(cdn) {
  return String(cdn || '').replace(/\/+$/, '');
}

function shouldRewrite(url) {
  if (!url) return false;

  // 不处理完整外链
  if (/^(https?:)?\/\//i.test(url)) return false;

  // 不处理 data URI、mailto、tel、锚点
  if (/^(data:|mailto:|tel:|#)/i.test(url)) return false;

  // 只处理站内绝对路径
  if (!url.startsWith('/')) return false;

  // 只处理 /images/ 下的图片
  if (!url.startsWith('/images/')) return false;

  return IMAGE_EXT_RE.test(url);
}

function rewriteUrl(url, cdn) {
  if (!shouldRewrite(url)) return url;
  return cdn + url;
}

function rewriteSrcset(value, cdn) {
  // 处理 srcset="/images/a.webp 1x, /images/b.webp 2x"
  return value
    .split(',')
    .map(item => {
      const trimmed = item.trim();
      const parts = trimmed.split(/\s+/);
      if (!parts.length) return item;

      parts[0] = rewriteUrl(parts[0], cdn);
      return parts.join(' ');
    })
    .join(', ');
}

hexo.extend.filter.register('after_render:html', function (html) {
  const cdn = normalizeCdn(hexo.config.image_cdn);

  if (!cdn) {
    hexo.log.warn('[R2 CDN] image_cdn is not set in _config.yml');
    return html;
  }

  let changed = 0;

  // 处理 src="", href="", data-src="", data-original="", data-lazy-src=""
  html = html.replace(
    /\b(src|href|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi,
    function (match, attr, url) {
      const newUrl = rewriteUrl(url, cdn);
      if (newUrl !== url) changed += 1;
      return `${attr}="${newUrl}"`;
    }
  );

  // 处理 srcset=""
  html = html.replace(
    /\bsrcset=["']([^"']+)["']/gi,
    function (match, value) {
      const newValue = rewriteSrcset(value, cdn);
      if (newValue !== value) changed += 1;
      return `srcset="${newValue}"`;
    }
  );

  if (changed > 0) {
    hexo.log.info(`[R2 CDN] rewritten ${changed} image URLs in one HTML file`);
  }

  return html;
});