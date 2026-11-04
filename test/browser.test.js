// Real-browser end-to-end test (Chrome). Drives the actual client: typing, Tab-accept, autocorrect + undo, outside-paste
// and drag blocking, chat, AI paste, Send, log view, comparison.   Needs:  npm i puppeteer-core   (and Google Chrome installed)
//   PUPPETEER_CORE=/path/to/node_modules/puppeteer-core SHOTS=/some/dir node test/browser.test.js
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 3600 + Math.floor(Math.random() * 90), base = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'aimc-browser-'));
const SHOTS = process.env.SHOTS || DATA;
const env = { ...process.env, PORT, DATA_DIR: DATA }; delete env.ANTHROPIC_API_KEY;
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOD = process.platform === 'darwin' ? 4 : 2;

(async () => {
  let browser;
  try {
    await sleep(700);
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--window-size=1400,900'], defaultViewport: { width: 1400, height: 900 } });
    await browser.defaultBrowserContext().overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await page.createCDPSession();
    const paste = async () => { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: MOD, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, commands: ['paste'] }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 }); await sleep(150); };
    const body = () => page.$eval('#body', e => e.value);
    const shot = n => page.screenshot({ path: path.join(SHOTS, n + '.png') });
    const caretTo = (a, b = a) => page.$eval('#body', (e, a, b) => { e.focus(); e.setSelectionRange(a, b); }, a, b);

    // ---- start ----
    await page.goto(base + '/?pid=P01'); await page.click('#startbtn');
    await page.waitForSelector('#beginbtn', { visible: true }); await shot('1-scenario'); await page.click('#beginbtn');
    await page.waitForSelector('#body', { visible: true });

    // ---- typing + autocomplete accept (Tab) ----
    await page.type('#body', 'Hi Sam,\n\nI wanted to', { delay: 20 });
    await page.waitForSelector('#mirror .ghost', { timeout: 5000 });
    assert.strictEqual(await page.$eval('#mirror .ghost', e => e.textContent), ' follow up on');
    await shot('2-ghost-suggestion');
    await page.keyboard.press('Tab');
    assert.strictEqual(await body(), 'Hi Sam,\n\nI wanted to follow up on');

    // ---- autocorrect kept ----
    await page.type('#body', ' the plan. Thanks for teh ', { delay: 20 });
    assert.strictEqual(await body(), 'Hi Sam,\n\nI wanted to follow up on the plan. Thanks for the ', 'teh -> the');
    // ---- autocorrect undone with one Backspace ----
    await page.type('#body', 'alot ', { delay: 20 });
    assert.ok((await body()).endsWith('a lot '), 'alot -> a lot');
    await page.keyboard.press('Backspace');
    assert.ok((await body()).endsWith('alot '), 'Backspace restores what was typed');
    await page.type('#body', 'of help. ', { delay: 20 });

    // ---- autocomplete rejected by typing over it ----
    await page.keyboard.type('Could we', { delay: 20 });
    await page.waitForSelector('#mirror .ghost', { timeout: 5000 });
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.$('#mirror .ghost'), null);

    // ---- outside paste is blocked; drop is blocked ----
    const before = await body();
    await page.evaluate(() => navigator.clipboard.writeText('TEXT FROM ANOTHER APP'));
    await caretTo(before.length); await paste();
    assert.strictEqual(await body(), before, 'outside paste must not insert');
    assert.ok((await page.$eval('#msg', e => e.textContent)).includes("isn't available"));
    await page.$eval('#body', e => { const dt = new DataTransfer(); dt.setData('text/plain', 'dragged'); e.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
    assert.strictEqual(await body(), before, 'drop must not insert');

    // ---- internal copy/paste inside the email is allowed and keeps labels ----
    await caretTo(0, 5);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: MOD, key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, commands: ['copy'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 }); await sleep(150);
    await caretTo(before.length); await paste();
    assert.strictEqual(await body(), before + 'Hi Sa', 'copy from the email and paste back in works');
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
    assert.strictEqual(await body(), before);

    // ---- AI chat ----
    await page.click('.tab[data-tab="chat"]');
    await page.type('#chatin', 'Can you make this more professional?'); await page.keyboard.press('Enter');
    await page.waitForSelector('.bubble.assistant:not(.streaming) .tools button', { timeout: 15000 });
    const reply = await page.$eval('.bubble.assistant .txt', e => e.textContent);
    assert.ok(reply.includes("I've finished the update"));
    await shot('3-chat');
    // pasting outside text into the chat is blocked too
    await page.evaluate(() => navigator.clipboard.writeText('OUTSIDE TEXT')); await page.focus('#chatin'); await paste();
    assert.strictEqual(await page.$eval('#chatin', e => e.value), '');
    // copy the reply with the copy button, go back to the email, paste it
    await page.click('.bubble.assistant .tools button');
    await page.click('.tab[data-tab="email"]');
    await page.waitForFunction(() => !document.getElementById('v-email').hidden);
    const pre = await body(); await caretTo(pre.length); await page.keyboard.press('Enter'); await paste();
    const pasted = (await body()).slice(pre.length + 1);
    assert.strictEqual(pasted, reply, 'the AI reply was pasted');
    // change "I've" -> "I have" inside the pasted AI text
    const i = (await body()).indexOf("I've");
    await caretTo(i + 1, i + 2); await page.keyboard.press('Backspace'); await page.keyboard.type(' ha', { delay: 30 });
    assert.ok((await body()).includes('I have finished the update'));
    // type a sentence that closely matches the AI reply
    await caretTo((await body()).length); await page.keyboard.type("\nPlease let me know if you'd like to discuss any of the details.", { delay: 5 });
    await sleep(3500);                                                  // let a snapshot happen
    await shot('4-email-after-ai');

    // ---- pilot checklist: refreshing the page mid-writing loses nothing ----
    const bodyBefore = await body(), bubblesBefore = await page.$$eval('.bubble', e => e.length);
    await page.reload(); await page.click('#startbtn'); await page.waitForSelector('#body', { visible: true });
    assert.strictEqual(await body(), bodyBefore, 'draft restored after refresh');
    assert.strictEqual(await page.$eval('#subject', e => e.value), 'PLACEHOLDER: Update on project');
    await page.click('.tab[data-tab="chat"]'); assert.strictEqual(await page.$$eval('.bubble', e => e.length), bubblesBefore, 'chat restored after refresh');
    await page.click('.tab[data-tab="email"]');

    // ---- send ----
    await page.click('#sendbtn'); await page.waitForSelector('#s-saved:not([hidden]) .lv-entry', { timeout: 10000 });
    await shot('5-log-view');
    const total = await page.$$eval('.lv-entry', e => e.length);
    // filter: AI pasted -> only AI entries (prompt, reply, the paste)
    await page.$eval('.lf-chip[data-g="source"][data-v="ai"]', b => b.click());
    const kinds = await page.$$eval('.lv-entry', es => es.map(e => e.className));
    assert.ok(kinds.length >= 3 && kinds.length < total && kinds.every(c => /k-prompt|k-reply|k-revision/.test(c)));
    assert.ok((await page.$$eval('.lv-entry .b-ai', e => e.length)) >= 3);
    await shot('6-log-filter-ai');
    await page.$eval('.lf-clear', b => b.click());
    await page.$eval('.lf-chip[data-g="aiEdit"]', b => b.click());
    assert.ok((await page.$$eval('.lv-entry', e => e.length)) >= 2, 'the I\'ve -> I have edits are listed');
    await shot('7-log-filter-ai-edits');
    await page.$eval('.lf-clear', b => b.click());

    // ---- second email, then comparison ----
    await page.click('#nextbtn'); await page.waitForSelector('#beginbtn', { visible: true }); await page.click('#beginbtn');
    await page.waitForSelector('#body', { visible: true });
    await page.type('#body', 'Hey Jordan, quick note about the draft.', { delay: 15 });
    await page.click('#sendbtn'); await page.waitForSelector('#cmpbtn:not([hidden])', { timeout: 10000 });
    await page.click('#cmpbtn'); await page.waitForSelector('#s-compare:not([hidden]) .lv-entry');
    await shot('8-comparison');
    assert.strictEqual((await page.$$eval('#cmpL .lv-title, #cmpR .lv-title', e => e.map(x => x.textContent))).length, 2);
    const sideCount = sel => page.$$eval(sel + ' .lv-entry', e => e.length);
    const bothBefore = [await sideCount('#cmpL'), await sideCount('#cmpR')];
    await page.click('#cmpfilters .lf-chip[data-g="source"][data-v="ai"]');   // one filter applies to both sides
    const bothAfter = [await sideCount('#cmpL'), await sideCount('#cmpR')];
    assert.ok(bothAfter[0] < bothBefore[0] && bothAfter[1] === 0, 'AI filter narrows the boss side and empties the colleague side: ' + bothBefore + ' -> ' + bothAfter);
    await shot('9-comparison-filtered');

    // ---- what was saved ----
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'P01', 'session.json'), 'utf8')).emails[0];
    assert.ok(saved.integrity.replay_matches_final_text && saved.integrity.labels_cover_text, JSON.stringify(saved.integrity));
    const types = new Set(saved.events.map(e => e.type));
    for (const t of ['keystroke', 'edit', 'delete', 'autocomplete_shown', 'autocomplete_accepted', 'autocomplete_dismissed', 'autocorrect_applied', 'autocorrect_undone',
                     'paste', 'copy', 'drop_blocked', 'ai_prompt', 'ai_reply', 'tab_switch', 'snapshot', 'send', 'clock_sync', 'writing_start'])
      assert.ok(types.has(t), 'event type logged: ' + t);
    assert.ok(saved.events.some(e => e.type === 'paste' && e.blocked && e.text === 'TEXT FROM ANOTHER APP'));
    assert.ok(saved.events.some(e => e.type === 'paste' && e.blocked && e.field === 'chat_input'));
    assert.ok(saved.events.some(e => e.type === 'paste' && !e.blocked && e.source_tag === 'ai' && e.from === 'R1'));
    assert.ok(saved.events.filter(e => e.type === 'autocorrect_applied').length === 2);
    if (process.env.DEBUG_EVENTS) console.log(saved.events.filter(e => /autocorrect/.test(e.type) || (e.type === 'edit' && e.via !== 'typed' && e.via !== 'paste_ai')).map(e => JSON.stringify(e)).join('\n'));
    const src = Object.fromEntries(saved.char_labels.map(r => [r.source, (r.end - r.start)]));
    console.log('final text:\n' + saved.final_text + '\n\nchar label totals (by run):', saved.char_labels.map(r => `${r.source}:${r.end - r.start}`).join(' '));
    for (const s of ['typed', 'autocomplete', 'autocorrect', 'ai']) assert.ok(src[s] > 0, 'labels contain ' + s);
    const at = saved.final_text.indexOf('I have');
    const lab = k => saved.char_labels.find(r => k >= r.start && k < r.end).source;
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map(k => lab(at + k)), ['ai', 'typed', 'typed', 'typed', 'ai', 'ai']);
    assert.deepStrictEqual(saved.ai_replies.map(r => [r.reply_id, r.used]), [['R1', true]]);
    assert.deepStrictEqual(errors, [], 'no console/page errors: ' + errors.join(' | '));
    console.log('browser tests passed. Screenshots in', SHOTS);
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  finally { if (browser) await browser.close(); srv.kill(); }
})();
