import fs from 'node:fs';
import crypto from 'node:crypto';

const PATCH_FILE = 'holiday-patch.json';
const STATE_FILE = 'automation/source-state.json';
const HEARTBEAT_FILE = 'automation/heartbeat.json';
const REVIEW_FILE = 'automation/review-required.md';
const LAW_URL = 'https://www.law.go.kr/LSW/lsInfoP.do?ancYnChk=0&lsId=002404';
const KASI_ALMANAC = y => `https://astro.kasi.re.kr/life/post/almanac?year=${y}`;
const KASI_CALENDAR = y => `https://astro.kasi.re.kr/life/post/calendarData?year=${y}`;
const MAX_YEAR = 2045;
const MAX_AUTO_ADDITIONS = 8;

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const pad2 = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const kstNow = () => new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Seoul'}));
const todayKST = () => {
  const d=kstNow(); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
};
const monthKST = () => todayKST().slice(0,7);

function decodeHtml(text='') {
  return String(text)
    .replace(/&#(\d+);/g, (_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");
}
function stripTags(text='') {
  return decodeHtml(String(text).replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' '))
    .replace(/\s+/g,' ').trim();
}
function normalizeSourceText(text='') {
  return stripTags(text).replace(/\s+/g,' ').trim();
}
async function fetchText(url, timeoutMs=15000) {
  const controller = new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const res=await fetch(url,{redirect:'follow',cache:'no-store',signal:controller.signal,headers:{'User-Agent':'afterschool-holiday-monitor/1.0','Accept-Language':'ko-KR,ko;q=0.9'}});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}
function cleanHolidayName(name='') {
  let s=stripTags(name).replace(/[＊*]+/g,'').replace(/\s+/g,' ').trim();
  const map={
    '1월 1일':'신정','3.1절':'삼일절','3·1절':'삼일절','어린이 날':'어린이날',
    '부처님 오신 날':'부처님오신날','기독탄신일':'성탄절'
  };
  return map[s]||s;
}
function addDays(date, count) {
  const d=new Date(date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+count);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
}
function expandDateText(year, raw, name) {
  const text=stripTags(raw).replace(/\([^)]*\)/g,'').replace(/\s+/g,' ').trim();
  let m=text.match(/(\d{1,2})월\s*(\d{1,2})일\s*[~～-]\s*(?:(\d{1,2})월\s*)?(\d{1,2})일/);
  if(m){
    const sm=Number(m[1]), sd=Number(m[2]), em=Number(m[3]||m[1]), ed=Number(m[4]);
    const start=iso(year,sm,sd), end=iso(year,em,ed), dates=[];
    for(let cur=start,guard=0; cur<=end && guard++<10; cur=addDays(cur,1)) dates.push(cur);
    if(name==='설날'||name==='추석') return dates.map((date,i)=>({date,name:i===Math.floor(dates.length/2)?name:`${name} 연휴`}));
    return dates.map(date=>({date,name}));
  }
  m=text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  return m?[{date:iso(year,Number(m[1]),Number(m[2])),name}]:[];
}
function parseKasiHolidayTable(html, year) {
  const start=html.indexOf('국경일과 공휴일');
  if(start<0) return {ok:false,reason:'국경일과 공휴일 표를 찾지 못했습니다.',holidays:{},confidence:0};
  let end=html.indexOf('일요일',start+10); if(end<0) end=Math.min(html.length,start+25000);
  const block=html.slice(start,end);
  const rows=[...block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const holidays={};
  let pairCount=0;
  for(const row of rows){
    const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>stripTags(m[1])).filter(Boolean);
    if(cells.length<2) continue;
    for(let i=0;i+1<cells.length;i+=2){
      const name=cleanHolidayName(cells[i]), dateText=cells[i+1];
      if(!name||/^(명칭|날짜|월|일)$/.test(name)||!/\d{1,2}월/.test(dateText)) continue;
      const expanded=expandDateText(year,dateText,name);
      if(!expanded.length) continue;
      pairCount++;
      for(const item of expanded) holidays[item.date]=holidays[item.date]?`${holidays[item.date]}·${item.name}`:item.name;
    }
  }
  const anchors=[`${year}-01-01`,`${year}-03-01`,`${year}-05-05`,`${year}-06-06`,`${year}-08-15`,`${year}-10-03`,`${year}-10-09`,`${year}-12-25`];
  const anchorHits=anchors.filter(d=>holidays[d]).length;
  const confidence=(pairCount>=8?1:0)+(anchorHits>=6?1:0)+(Object.keys(holidays).length>=10?1:0);
  return {ok:confidence>=2,reason:confidence>=2?'':'공휴일 표 파싱 신뢰도가 낮습니다.',holidays,confidence,pairCount,anchorHits};
}
function almanacStatus(html, year) {
  const text=normalizeSourceText(html);
  const title=text.includes(`${year}년 월력요항`);
  const gazette=text.includes('대한민국 전자관보로 이동');
  return {official:title&&gazette,title,gazette,hash:sha256(text)};
}
function currentPatchMap(patch) {
  const map={};
  for(const row of patch.holidays||[]){ if(row&&row.date&&String(row.action||'set').toLowerCase()!=='remove') map[row.date]=row.name||row.reason||'공휴일'; }
  return map;
}
function safeAutoName(name='') {
  return /(?:임시공휴일|선거일|대체공휴일)/.test(name);
}
function versionForToday(current='') {
  const prefix=todayKST().replace(/-/g,'.');
  const m=String(current).match(new RegExp(`^${prefix.replace(/\./g,'\\.')}\\.auto(\\d+)$`));
  return `${prefix}.auto${m?Number(m[1])+1:1}`;
}
function writeReview(lines) {
  if(!lines.length){ try{fs.unlinkSync(REVIEW_FILE)}catch{}; return; }
  const body=[
    '# 공휴일 자동검증 검토 필요','',
    `감지시각: ${todayKST()} (KST)`,'',
    '자동 반영 안전조건을 충족하지 않아 중앙 `holiday-patch.json`은 변경하지 않았습니다.','',
    ...lines.map(x=>`- ${x}`),'',
    '확인 후 필요한 경우 기준 엔진 또는 중앙 패치를 수동으로 수정하세요.'
  ].join('\n');
  fs.writeFileSync(REVIEW_FILE,body+'\n');
}

async function main(){
  const patch=readJSON(PATCH_FILE), state=readJSON(STATE_FILE), heartbeat=readJSON(HEARTBEAT_FILE);
  const now=kstNow(), currentYear=now.getFullYear();
  const years=[]; for(let y=currentYear;y<=Math.min(MAX_YEAR,currentYear+3);y++) years.push(y);
  const review=[];

  const lawHtml=await fetchText(LAW_URL);
  const lawText=normalizeSourceText(lawHtml);
  if(!lawText.includes('관공서의 공휴일에 관한 규정')||!lawText.includes('대체공휴일')) throw new Error('국가법령정보센터 공휴일 규정 본문을 확인하지 못했습니다.');
  const lawHash=sha256(lawText);
  const previousLawHash=state.sources?.law?.hash||'';
  const lawChanged=!!(state.initialized&&previousLawHash&&previousLawHash!==lawHash);
  if(lawChanged) review.push('국가법령정보센터의 「관공서의 공휴일에 관한 규정」 본문 변경을 감지했습니다. 규칙 변경은 자동 패치하지 않습니다.');

  const nextYears={};
  const observedAdditions=[];
  const patchMap=currentPatchMap(patch);
  for(const year of years){
    const [almanacHtml,calendarHtml]=await Promise.all([fetchText(KASI_ALMANAC(year)),fetchText(KASI_CALENDAR(year))]);
    const alm=almanacStatus(almanacHtml,year), parsed=parseKasiHolidayTable(calendarHtml,year);
    const calendarHash=sha256(JSON.stringify(parsed.holidays));
    const previous=state.years?.[year]||{};
    const sourceChanged=!!(state.initialized && previous.calendarHash && previous.calendarHash!==calendarHash);
    const officialBecameAvailable=!!(state.initialized && !previous.official && alm.official);
    nextYears[year]={official:alm.official,almanacHash:alm.hash,calendarHash,parseOk:parsed.ok,holidayCount:Object.keys(parsed.holidays).length,observedHolidayMap:parsed.holidays};

    if(!state.initialized || !(sourceChanged||officialBecameAvailable)) continue;
    if(!parsed.ok){ review.push(`${year}년 한국천문연구원 달력자료의 공휴일 표 파싱 신뢰도가 낮아 자동 반영을 중지했습니다.`); continue; }
    const prevObserved=previous.observedHolidayMap||{};
    if(sourceChanged){
      for(const [date,name] of Object.entries(parsed.holidays)){
        if(prevObserved[date]||patchMap[date]) continue;
        observedAdditions.push({year,date,name,official:alm.official,reason:'source-changed'});
      }
      for(const [date,oldName] of Object.entries(prevObserved)){
        const nextName=parsed.holidays[date];
        if(!nextName){
          if(patchMap[date]||safeAutoName(oldName)) review.push(`${year}년 공식자료에서 ${date}(${oldName})가 사라졌습니다. 삭제는 자동 수행하지 않습니다.`);
        }else if(nextName!==oldName && (safeAutoName(oldName)||safeAutoName(nextName))){
          review.push(`${year}년 ${date} 공휴일 명칭이 '${oldName}' → '${nextName}'으로 변경되었습니다. 이름 변경은 자동 반영하지 않습니다.`);
        }
      }
    }
    if(officialBecameAvailable){
      for(const [date,name] of Object.entries(parsed.holidays)){
        if(patchMap[date]||!/선거일|임시공휴일/.test(name)) continue;
        observedAdditions.push({year,date,name,official:true,reason:'official-became-available'});
      }
    }
  }

  let approved=[];
  if(!lawChanged){
    for(const c of observedAdditions){
      if(!c.official){ review.push(`${c.date} ${c.name}: 해당 연도의 공식 월력요항 게재 확인 전이므로 자동 적용하지 않았습니다.`); continue; }
      if(!safeAutoName(c.name)){ review.push(`${c.date} ${c.name}: 임시공휴일·선거일·대체공휴일 범주가 아니어서 자동 적용하지 않았습니다.`); continue; }
      approved.push(c);
    }
  }
  approved=[...new Map(approved.map(x=>[x.date,x])).values()];
  if(approved.length>MAX_AUTO_ADDITIONS){ review.push(`한 번에 ${approved.length}건의 신규 공휴일이 감지되어 안전한 자동 반영 한도(${MAX_AUTO_ADDITIONS}건)를 초과했습니다.`); approved=[]; }

  if(state.initialized && approved.length){
    const existing=new Map((patch.holidays||[]).map(r=>[r.date,r]));
    for(const c of approved) existing.set(c.date,{date:c.date,name:c.name,action:'set',mode:'replace'});
    patch.schema='after-school-holidays-v1';
    patch.version=versionForToday(patch.version);
    patch.referenceDate=todayKST();
    patch.source='공식자료 자동검증 중앙 공휴일 패치';
    patch.holidays=[...existing.values()].sort((a,b)=>a.date.localeCompare(b.date));
    patch.removeDates=Array.isArray(patch.removeDates)?patch.removeDates:[];
    patch.verification={mode:'automatic-confirmed-only',checkedAt:todayKST(),sources:['국가법령정보센터','한국천문연구원 월력요항','한국천문연구원 달력자료'],autoAdded:approved.map(x=>({date:x.date,name:x.name}))};
    writeJSON(PATCH_FILE,patch);
    console.log(`[AUTO-PATCH] ${approved.length}건 적용:`,approved);
  }

  const nextState={
    schema:'after-school-holiday-source-state-v1',initialized:true,
    sources:{law:{url:LAW_URL,hash:lawHash}},
    years:nextYears,
    lastResult:{date:todayKST(),autoApplied:approved.map(x=>({date:x.date,name:x.name})),reviewRequired:review.length>0}
  };
  const meaningfulChanged=JSON.stringify({...state,lastResult:undefined})!==JSON.stringify({...nextState,lastResult:undefined});
  if(!state.initialized||meaningfulChanged||approved.length||review.length) writeJSON(STATE_FILE,nextState);

  if(heartbeat.month!==monthKST()) writeJSON(HEARTBEAT_FILE,{schema:'after-school-holiday-heartbeat-v1',month:monthKST(),checkedBy:'GitHub Actions'});
  writeReview(review);
  console.log(`[DONE] initialized=${state.initialized} approved=${approved.length} review=${review.length}`);
}

main().catch(error=>{console.error(error);process.exit(1)});
