// Real profile gate, native audio decoding and the reader in headless Comet.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './comet.mjs';
import { prepareProfile } from './scripts/profile-fixture.mjs';

const root = process.env.BW_DIR || fileURLToPath(new URL('.', import.meta.url));
const output = process.env.BLAZING_MEDIA_REVIEW_DIR || '/tmp/blazing-media-library-review';
await mkdir(output, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try { const body = await readFile(join(root, path === '/' ? 'index.html' : path)); res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// A small, original PCM sine tone, generated in memory. No copyrighted audio,
// external downloads, ffmpeg process or mocked HTMLMediaElement is involved.
function tone(hz, seconds = 8) {
  const rate = 8000, size = rate * seconds * 2, wav = Buffer.alloc(44 + size);
  wav.write('RIFF'); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28);
  wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(size,40);
  for (let n=0; n<size/2; n++) wav.writeInt16LE(Math.round(1200*Math.sin(2*Math.PI*hz*n/rate)),44+n*2);
  return wav;
}
const tones = { '/first.wav': tone(220), '/next.wav': tone(440,18) };
const readers = [
  { id:'reader-a',name:'Reader',maxRating:'mature',effectiveMaxRating:'mature',hasPin:true,isKids:false },
  { id:'reader-b',name:'Second reader',maxRating:'mature',effectiveMaxRating:'mature',hasPin:false,isKids:false },
  { id:'teen-reader',name:'Teen reader',maxRating:'teen',effectiveMaxRating:'teen',hasPin:false,isKids:false },
];
const album = { id:'archive:owned-audio-fixture',title:'Studio notes',creator:'Blazing test recording',ageRating:'unknown' };
const show = { id:'itunes:123',title:'The listening desk',creator:'Blazing test recording',ageRating:'unknown' };
const tracks = [
  { id:'fixture-track-first',title:'First study',url:'https://audio.example.test/first.wav',durationSeconds:8,ageRating:'unknown' },
  { id:'fixture-track-next',title:'Second study',url:'https://audio.example.test/next.wav',durationSeconds:18,ageRating:'unknown' },
];
const fullText = Array.from({length:240},(_,i)=>`Field note ${i+1}\nThis text is an original reader fixture. It checks clear type, saved position and a complete book.\n`).join('\n') + '\nEND OF COMPLETE READER FIXTURE';
const bookFor = (profileId) => ({ id:'gutenberg:11',title:profileId === 'reader-b' ? 'Second reader notes' : 'Field notes',authors:['Blazing test edition'],ageRating:'unknown',formats:{text:'https://www.gutenberg.org/ebooks/11.txt.utf-8'} });
const reply = (route, data, status=200) => route.fulfill({status,contentType:'application/json',headers:{'cache-control':'private, no-store'},body:JSON.stringify(data)});
const check = (condition, message) => { assert.ok(condition,message); evidence.checks.push(message); console.log('PASS '+message); };
const evidence = { checks:[],mediaRequests:[],audioSamples:[],screenshots:[] };
let browser, page, releaseBook, holdBook=false, rejectSearch=false, nextUnlockMs=3600000;
try {
  browser = await launchBrowser();
  const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'audio.example.test') {
      const body=tones[url.pathname]; if(!body)return route.abort();
      const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range||'');
      const start=range?Number(range[1]):0, end=range&&range[2]?Math.min(body.length-1,Number(range[2])):body.length-1;
      return route.fulfill({status:range?206:200,contentType:'audio/wav',headers:{'accept-ranges':'bytes',...(range?{'content-range':`bytes ${start}-${end}/${body.length}`}:{})},body:body.subarray(start,end+1)});
    }
    if (url.origin===base && !url.pathname.startsWith('/fleet/'))return route.continue();
    const path=url.pathname.replace(/^\/fleet/,'');
    if (path.startsWith('/media/')) {
      const headers=route.request().headers(),profileId=url.searchParams.get('profileId');
      const call={path,profileId,deviceId:url.searchParams.get('deviceId'),hasDeviceToken:headers['x-device-token']==='tok',hasUnlock:headers['x-unlock-token']==='fixture-media-unlock'};
      evidence.mediaRequests.push(call);
      if(call.deviceId!=='dev-1'||!call.hasDeviceToken||!readers.some(row=>row.id===profileId))return reply(route,{error:'unauthorized'},401);
      if(profileId==='teen-reader'||profileId==='reader-a'&&!call.hasUnlock)return reply(route,{error:'profile-restricted'},403);
      if(path==='/media/books')return reply(route,rejectSearch?{error:'source-timeout'}:{items:[bookFor(profileId)]},rejectSearch?503:200);
      if(path==='/media/books/gutenberg%3A11'||path==='/media/books/gutenberg:11')return reply(route,bookFor(profileId));
      if(path.endsWith('/text')){
        if(holdBook)await new Promise(resolve=>{releaseBook=resolve;});
        try{return await reply(route,{id:'gutenberg:11',title:bookFor(profileId).title,text:fullText,truncated:false});}catch{ return; }
      }
      if(path==='/media/music')return reply(route,{items:[album]});
      if(path.endsWith('/tracks'))return reply(route,{...album,items:tracks});
      if(path==='/media/podcasts')return reply(route,{items:[show]});
      if(path.endsWith('/episodes'))return reply(route,{...show,items:tracks});
      return reply(route,{error:'not-found'},404);
    }
    if(/\/profiles\/reader-a\/verify$/.test(path))return reply(route,{ok:true,unlockToken:'fixture-media-unlock',expiresAt:new Date(Date.now()+nextUnlockMs).toISOString()});
    if(path==='/manifest.json')return reply(route,{catalogs:[]});
    return reply(route,{items:[],metas:[],profiles:readers});
  });
  await prepareProfile(context,readers[0]);
  await context.route('https://fleet.lyreosai.com/profiles?*',route=>reply(route,{profiles:readers}));
  page=await context.newPage(); page.setDefaultTimeout(45000);
  const faults=[];page.on('pageerror',error=>faults.push(error.message));
  async function choose(name,pin=false){
    await page.getByRole('button',{name:`Choose ${name}${pin?', PIN required':''}`,exact:true}).click();
    if(pin){for(let n=0;n<4;n++)await page.locator('.bp-digit[data-digit="1"]').click();await page.locator('.bp-pin .bp-verify').click();}
    await page.locator('.bp-layer').waitFor({state:'hidden'});
  }
  async function profile(name,pin=false){await page.locator('.bp-connect').click();await choose(name,pin);}
  async function openSearchItem(label) {
    await page.locator('#search-button').click();
    await page.locator('#search-input').fill('Field notes');
    await page.locator('#search-form').getByRole('button',{name:'Search',exact:true}).click();
    const selected=page.locator('#search-media-results').getByRole('button',{name:label,exact:true});await selected.waitFor();
    const before=evidence.mediaRequests.filter(call=>/^\/media\/(books|music|podcasts)$/.test(call.path)).length;
    await selected.click();
    return before;
  }
  const room=()=>page.locator('#media-view');
  const tab=kind=>room().getByRole('navigation',{name:'Books and audio'}).getByRole('button',{name:kind,exact:true});
  const audio=()=>page.locator('#media-player-host audio');
  const shot=async(name)=>{const path=join(output,name+'.png');await page.screenshot({path,fullPage:false});evidence.screenshots.push(path);};
  await page.goto(base+'/index.html');
  await page.getByRole('button',{name:'Choose Reader, PIN required',exact:true}).waitFor();
  check(evidence.mediaRequests.length===0,'profile gate prevents early catalog requests');
  await choose('Reader',true);
  await page.locator('.topnav [data-view="books"]').click();
  await room().getByRole('button',{name:'Read Field notes',exact:true}).waitFor();
  check(evidence.mediaRequests.every(call=>call.hasDeviceToken&&call.hasUnlock&&call.profileId==='reader-a'),'catalog route carries selected profile, device and PIN unlock');
  await shot('media-books-desktop');
  await room().getByRole('button',{name:'Read Field notes',exact:true}).click();
  const reader=page.locator('.media-book-text');await reader.waitFor();
  check((await reader.textContent())===fullText,'reader receives complete text, including final marker');
  await reader.focus();await page.keyboard.press('ArrowDown');
  await page.waitForFunction(()=>document.querySelector('.media-book-text')?.scrollTop>0);
  check(await reader.evaluate(node=>document.activeElement===node),'reader arrow scroll stays inside the book');
  await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.querySelector('.media-book-text')?.scrollTop>0);
  const position=await reader.evaluate(node=>node.scrollTop/(node.scrollHeight-node.clientHeight));
  await shot('media-reader-desktop');
  await page.getByRole('button',{name:'Close book',exact:true}).click();
  await room().getByRole('button',{name:'Read Field notes',exact:true}).click();await reader.waitFor();
  await page.waitForFunction(ratio=>{const node=document.querySelector('.media-book-text');return node&&Math.abs(node.scrollTop/(node.scrollHeight-node.clientHeight)-ratio)<0.02;},position);
  check(true,'book reopens at this profile’s saved position');await page.keyboard.press('Escape');
  const beforeBookOpen=await openSearchItem('Read Field notes');await reader.waitFor();
  check(evidence.mediaRequests.filter(call=>/^\/media\/(books|music|podcasts)$/.test(call.path)).length===beforeBookOpen,'main Search opens its chosen book without another catalog search');
  check((await reader.textContent())===fullText,'main Search reaches the complete reader directly');await page.keyboard.press('Escape');
  rejectSearch=true;await room().getByRole('searchbox').fill('temporary failure');await room().getByRole('button',{name:'Search',exact:true}).click();
  await room().getByRole('button',{name:'Try again',exact:true}).waitFor();rejectSearch=false;
  await room().getByRole('button',{name:'Try again',exact:true}).click();await room().getByRole('button',{name:'Read Field notes',exact:true}).waitFor();
  check(true,'source error offers a working retry');
  const beforeMusicOpen=await openSearchItem('Open Studio notes');await room().getByRole('button',{name:'First study',exact:true}).waitFor();
  check(evidence.mediaRequests.filter(call=>/^\/media\/(books|music|podcasts)$/.test(call.path)).length===beforeMusicOpen,'main Search opens its chosen album tracks without a second search');
  await room().getByRole('button',{name:'First study',exact:true}).click();
  await page.waitForFunction(()=>{const a=document.querySelector('#media-player-host audio');return a&&a.readyState>=2&&a.currentTime>0.2&&!a.paused&&!a.error;});
  evidence.audioSamples.push(await audio().evaluate(a=>({src:a.currentSrc,seconds:a.currentTime,duration:a.duration,readyState:a.readyState,error:a.error?.code||null})));
  check(true,'native audio decodes and advances the original WAV fixture');
  const player=page.locator('#media-player-host');await player.getByRole('button',{name:'Pause',exact:true}).click();
  check(await audio().evaluate(a=>a.paused),'Pause stops native audio');
  const seek=player.getByRole('slider',{name:'Audio position'});await seek.focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');
  check(Math.abs(await audio().evaluate(a=>a.currentTime)-2)<0.2,'keyboard seek changes native playback position');
  await player.getByRole('button',{name:'Play',exact:true}).click();await seek.focus();await page.keyboard.press('End');
  await page.waitForFunction(()=>document.querySelector('#media-player-host audio')?.currentSrc.endsWith('/next.wav'));
  await page.waitForFunction(()=>document.querySelector('#media-player-host audio')?.currentTime>0.2);
  check(await player.locator('.media-audio-title').innerText()==='Second study','ended automatically starts the next queued recording');
  await player.getByRole('button',{name:'Pause',exact:true}).click();await seek.focus();await page.keyboard.press('Home');
  for(let n=0;n<5;n++)await page.keyboard.press('ArrowRight');
  await page.locator('#brand-button').click();
  check(await player.isVisible()&&await audio().evaluate(a=>a.currentTime>=4.9),'shared audio player survives leaving its room');
  await profile('Second reader');
  check(await player.isHidden()&&await audio().evaluate(a=>!a.getAttribute('src')),'switching profiles removes former queue and media URL');
  await page.locator('.topnav [data-view="books"]').click();await room().getByRole('button',{name:'Read Second reader notes',exact:true}).click();
  await reader.waitFor();check(await reader.evaluate(node=>node.scrollTop)===0,'a second profile does not inherit book position');await page.keyboard.press('Escape');
  await profile('Reader',true);await player.getByRole('button',{name:'Resume',exact:true}).click();
  await page.waitForFunction(()=>{const a=document.querySelector('#media-player-host audio');return a&&a.currentSrc.endsWith('/next.wav')&&a.currentTime>=4.9;});
  await player.getByRole('button',{name:'Pause',exact:true}).click();check(true,'saved audio resolves again and resumes for its original profile');
  await tab('Podcasts').click();await room().getByRole('button',{name:'Open The listening desk',exact:true}).click();
  await room().getByRole('button',{name:'First study',exact:true}).waitFor();
  check(evidence.mediaRequests.some(call=>call.path.endsWith('/episodes')),'podcast room opens real enclosure rows');
  await page.setViewportSize({width:393,height:852});await shot('media-podcast-phone');
  const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('#media-player-host .media-audio-controls button')].map(node=>({label:node.textContent,height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width}))}));
  check(bounds.scroll<=bounds.width+1,'phone layout has no horizontal page overflow');
  check(bounds.buttons.length===4&&bounds.buttons.every(button=>button.height>=43&&button.width>=43),'all four phone audio controls have usable touch targets');
  await tab('Books').click();await room().getByRole('button',{name:'Read Field notes',exact:true}).click();await reader.waitFor();await shot('media-reader-phone');
  const readable=await reader.evaluate(node=>({height:node.clientHeight,width:node.clientWidth,scroll:node.scrollHeight}));
  check(readable.height>160&&readable.width>250&&readable.scroll>readable.height,'phone book has a usable scrolling text area');await page.keyboard.press('Escape');
  holdBook=true;await room().getByRole('button',{name:'Read Field notes',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.media-library-status')?.textContent.includes('Opening book'));
  const heldUntil=Date.now()+15000;
  while(!releaseBook&&Date.now()<heldUntil)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(releaseBook,'reader fixture request arrived within its deadline');
  await profile('Second reader');holdBook=false;releaseBook();releaseBook=null;
  await room().getByRole('button',{name:'Read Second reader notes',exact:true}).waitFor();
  check(await page.locator('.media-book-reader').count()===0,'late reader reply cannot reopen after a real profile switch');
  nextUnlockMs=12000;await profile('Reader',true);
  await player.getByRole('button',{name:'Resume',exact:true}).click();
  await page.waitForFunction(()=>{const a=document.querySelector('#media-player-host audio');return a&&a.readyState>=2&&!a.paused;});
  await room().getByRole('button',{name:'Read Field notes',exact:true}).click();await reader.waitFor();
  await page.waitForFunction(()=>!document.querySelector('.media-book-reader')&&!document.querySelector('#media-player-host audio')?.getAttribute('src'));
  check(await player.isHidden(),'real PIN expiry closes the open reader and clears playing audio');
  const choice=room().getByRole('button',{name:'Choose profile',exact:true});await choice.click();
  await page.getByRole('button',{name:'Choose Reader, PIN required',exact:true}).waitFor();
  check(true,'expired library has a working Choose profile action');
  nextUnlockMs=3600000;await choose('Second reader');
  const beforeTeen=evidence.mediaRequests.length;await profile('Teen reader');
  await room().getByText(/Choose a Mature or Adult profile/).waitFor();
  check(evidence.mediaRequests.length===beforeTeen,'Teen profile cannot request the unrated catalogs');
  check(faults.length===0,'no uncaught browser errors: '+faults.join('; '));
  await context.close();
  await writeFile(join(output,'media-library-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`media-library: ${evidence.checks.length} browser checks passed`);
} catch(error) {
  if(page)await page.screenshot({path:join(output,'media-library-failure.png')}).catch(()=>{});
  throw error;
} finally {
  releaseBook?.();await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
