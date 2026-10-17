import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '../../public');
const jsDir = path.join(publicDir, 'js');

describe('Static HTML and JS Security Auditing', () => {
  const htmlFiles = fs
    .readdirSync(publicDir)
    .filter((f) => f.endsWith('.html'));

  it('found all expected public HTML pages', () => {
    assert.ok(
      htmlFiles.length >= 9,
      `Expected at least 9 HTML files, found ${htmlFiles.length}`
    );
    assert.ok(htmlFiles.includes('index.html'));
    assert.ok(htmlFiles.includes('login.html'));
    assert.ok(htmlFiles.includes('register.html'));
    assert.ok(htmlFiles.includes('tenancies.html'));
    assert.ok(htmlFiles.includes('tenancy.html'));
    assert.ok(htmlFiles.includes('inspection.html'));
    assert.ok(htmlFiles.includes('compare.html'));
    assert.ok(htmlFiles.includes('settlement.html'));
    assert.ok(htmlFiles.includes('landlord.html'));
    assert.ok(htmlFiles.includes('404.html'));
  });

  for (const file of htmlFiles) {
    describe(`Audit: ${file}`, () => {
      const filePath = path.join(publicDir, file);
      const content = fs.readFileSync(filePath, 'utf8');

      it('has a valid lang attribute on <html>', () => {
        assert.match(
          content,
          /<html\s+[^>]*lang=["'][a-zA-Z]{2,}(-[a-zA-Z0-9]+)?["']/i,
          `${file} must have a lang attribute on <html> tag`
        );
      });

      it('has a non-empty <title> tag', () => {
        const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
        assert.ok(titleMatch, `${file} must contain a <title> tag`);
        assert.ok(
          titleMatch[1].trim().length > 0,
          `${file} title must not be empty`
        );
      });

      it('has a viewport <meta> tag', () => {
        assert.match(
          content,
          /<meta\s+[^>]*name=["']viewport["'][^>]*content=["'][^"']*width=device-width[^"']*["']/i,
          `${file} must contain a viewport meta tag with width=device-width`
        );
      });

      it('contains no inline style= attributes', () => {
        const styleMatches = [
          ...content.matchAll(/\bstyle\s*=\s*["'][^"']*["']/gi),
        ];
        assert.equal(
          styleMatches.length,
          0,
          `${file} contains inline style= attributes: ${styleMatches.map((m) => m[0]).join(', ')}`
        );
      });

      it('contains no inline on*= event handler attributes', () => {
        const onMatches = [
          ...content.matchAll(/\bon\w+\s*=\s*["'][^"']*["']/gi),
        ];
        assert.equal(
          onMatches.length,
          0,
          `${file} contains inline on*= event handlers: ${onMatches.map((m) => m[0]).join(', ')}`
        );
      });

      it('has no inline <script> bodies (every script has a src)', () => {
        const scriptTags = [
          ...content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
        ];
        for (const [fullTag, attrs, body] of scriptTags) {
          assert.match(
            attrs,
            /\bsrc=["'][^"']+["']/,
            `${file} has a <script> tag missing src: ${fullTag}`
          );
          assert.equal(
            body.trim(),
            '',
            `${file} has a <script> tag with an inline body: ${body.trim()}`
          );
        }
      });
    });
  }

  function getAllJsFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getAllJsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
    return files;
  }

  it('audits public/js for setAttribute("style") and innerHTML assignments', () => {
    const jsFiles = getAllJsFiles(jsDir);
    assert.ok(jsFiles.length > 0, 'Found JS files in public/js');

    const styleSetHits = [];
    const innerHtmlHits = [];

    for (const file of jsFiles) {
      const relPath = path.relative(publicDir, file);
      const code = fs.readFileSync(file, 'utf8');

      // Check for setAttribute('style'
      if (/setAttribute\(\s*['"]style['"]/i.test(code)) {
        styleSetHits.push(relPath);
      }

      // Check for .innerHTML = assignments
      const innerHtmlMatches = [...code.matchAll(/\.innerHTML\s*=/g)];
      if (innerHtmlMatches.length > 0) {
        innerHtmlHits.push({ file: relPath, count: innerHtmlMatches.length });
      }
    }

    assert.equal(
      styleSetHits.length,
      0,
      `Found setAttribute('style') in: ${styleSetHits.join(', ')}`
    );

    // No innerHTML assignments should exist, especially none handling user data
    assert.equal(
      innerHtmlHits.length,
      0,
      `Found innerHTML assignments in: ${JSON.stringify(innerHtmlHits)}`
    );
  });
});
