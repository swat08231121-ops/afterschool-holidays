import fs from 'node:fs';
import crypto from 'node:crypto';

const PATCH_FILE='holiday-patch.json';
const STATE_FILE='automation/source-state.json';
const HEARTBEAT_FILE='automation/heartbeat.json';
const STATUS_FILE='automation/status.json';
const REVIEW_FILE='automation/review-required.md';
const LAW_URL='https://www.law.go.kr/LSW/lsInfoP.do?ancYnChk=0&lsId=002404';
const KASI_ALMANAC=y=>`https://astro.kasi.re.kr/life/post/almanac?year=${y}`;
const KASI_CALENDAR=y=>`https://astro.kasi.re.kr/life/post/calendarData?year=${y}`;
const ISSUE_PAGE='https://github.com/swat08231121-ops/afterschool-holidays/issues';
const MAX_YEAR=2045;
const MAX_AUTO_ADDITIONS=8;

const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const writeJSON=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const pad2=n=>String(n).padStart(2,'0');
const iso=(y,m,d)=>`${y}-${pad2(m)}-${pad2(d)}`;
const kstNow=()=>new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}));
const todayKST=()=>{const d=kstNow();return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`};
const monthKST=()=>todayKST().slice(0,7);
const shortError=error=>String(error?.cause?.code||error?.code||error?.message||error||'unknown error').replace(/\s+/g,' ').slice(0,180);

function decodeHtml(text=''){
  return String(text)
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");
}
function stripTags(text=''){
  return decodeHtml(String(text).replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}
function normalizeSourceText(text=''){return stripTags(text).replace(/\s+/g,' ').trim()}

async function fetchText(url,timeoutMs=15000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(url,{redirect:'follow',cache:'no-store',signal:controller.signal,headers:{
      'User-Agent':'afterschool-holiday-monitor/1.2',
      'Accept-Language':'ko-KR,ko;q=0.9',
      'Accept':'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }finally{clearTimeout(timer)}
}

async function tryFetchText(url,label,attempts=2){
  let lastError=null;
  for(let attempt=1;attempt<=attempts;attempt++){
    try{
      const text=await fetchText(url);
      return {ok:true,text,error:'',label};
    }catch(error){
      lastError=error;
      console.warn(`[SOURCE-WARN] ${label} attempt ${attempt}/${attempts}: ${shortError(error)}`);
      if(attempt<attempts)await new Promise(resolve=>setTimeout(resolve,attempt*1500));
    }
  }
  return {ok:false,text:'',error:shortError(lastError),label};
}

function cleanHolidayName(name=''){
  const s=stripTags(name).replace(/[＊*]+/g,'').replace(/\s+/g,' ').trim();
  return ({'1월 1일':'신정','3.1절':'삼일절','3·1절':'삼일절','어린이 날':'어린이날','부처님 오신 날':'부처님오신날','기독탄신일':'성탄절'})[s]||s;
}
function addDays(date,count){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+count);return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`}
function expandDateText(year,raw,name){
  const text=stripTags(raw).replace(/\([^)]*\)/g,'').replace(/\s+/g,' ').trim();
  let m=text.match(/(\d{1,2})월\s*(\d{1,2})일\s*[~～-]\s*(?:(\d{1,2})월\s*)?(\d{1,2})일/);
  if(m){
    const sm=Number(m[1]),sd=Number(m[2]),em=Number(m[3]||m[1]),ed=Number(m[4]),start=iso(year,sm,sd),end=iso(year,em,ed),dates=[];
    for(let cur=start,guard=0;cur<=end&&guard++<10;cur=addDays(cur,1))dates.push(cur);
    if(name==='설날'||name==='추석')return dates.map((date,i)=>({date,name:i===Math.floor(dates.length/2)?name:`${name} 연휴`}));
    return dates.map(date=>({date,name}));
  }
  m=text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  return m?[{date:iso(year,Number(m[1]),Number(m[2])),name}]:[];
}
function parseKasiHolidayTable(html,year){
  const yearToken=`${year}년 달력자료`,yearStart=html.indexOf(yearToken);
  if(yearStart<0)return {ok:false,reason:`${year}년 달력자료 구간을 찾지 못했습니다.`,holidays:{},confidence:0};
  const nextToken=`${year-1}년 달력자료`;let yearEnd=html.indexOf(nextToken,yearStart+yearToken.length);
  if(yearEnd<0)yearEnd=Math.min(html.length,yearStart+180000);
  const yearBlock=html.slice(yearStart,yearEnd),localStart=yearBlock.indexOf('국경일과 공휴일');
  if(localStart<0)return {ok:false,reason:`${year}년 국경일과 공휴일 표를 찾지 못했습니다.`,holidays:{},confidence:0};
  let localEnd=yearBlock.indexOf('일요일',localStart+10);if(localEnd<0)localEnd=Math.min(yearBlock.length,localStart+30000);
  const block=yearBlock.slice(localStart,localEnd),rows=[...block.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)],holidays={};let pairCount=0;
  for(const row of rows){
    const cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m=>stripTags(m[1])).filter(Boolean);
    if(cells.length<2)continue;
    for(let i=0;i+1<cells.length;i+=2){
      const name=cleanHolidayName(cells[i]),dateText=cells[i+1];
      if(!name||/^(명칭|날짜|월|일)$/.test(name)||!/\d{1,2}월/.test(dateText))continue;
      const expanded=expandDateText(year,dateText,name);if(!expanded.length)continue;pairCount++;
      for(const item of expanded)holidays[item.date]=holidays[item.date]?`${holidays[item.date]}·${item.name}`:item.name;
    }
  }
  const anchors=[`${year}-01-01`,`${year}-03-01`,`${year}-05-05`,`${year}-06-06`,`${year}-08-15`,`${year}-10-03`,`${year}-10-09`,`${year}-12-25`];
  const anchorHits=anchors.filter(d=>holidays[d]).length,confidence=(pairCount>=8?1:0)+(anchorHits>=6?1:0)+(Object.keys(holidays).length>=10?1:0);
  return {ok:confidence>=2,reason:confidence>=2?'':'공휴일 표 파싱 신뢰도가 낮습니다.',holidays,confidence,pairCount,anchorHits};
}
function almanacStatus(html,year){
  const text=normalizeSourceText(html),title=text.includes(`${year}년 월력요항`),gazette=text.includes('대한민국 전자관보로 이동');
  return {official:title&&gazette,title,gazette,hash:sha256(text)};
}
function currentPatchMap(patch){const map={};for(const row of patch.holidays||[])if(row&&row.date&&String(row.action||'set').toLowerCase()!=='remove')map[row.date]=row.name||row.reason||'공휴일';return map}
function safeAutoName(name=''){return /(?:임시공휴일|선거일|대체공휴일)/.test(name)}
function versionForToday(current=''){
  const prefix=todayKST().replace(/-/g,'.'),m=String(current).match(new RegExp(`^${prefix.replace(/\./g,'\\.')}\\.auto(\\d+)$`));
  return `${prefix}.auto${m?Number(m[1])+1:1}`;
}
function reviewItem(category,detail,userAction,autoAction='중앙 공휴일 패치를 변경하지 않고 기존 검증자료를 유지합니다.'){
  return {category,detail,autoAction,userAction};
}
function writeReview(items){
  if(!items.length){try{fs.unlinkSync(REVIEW_FILE)}catch{};return}
  const categories=[...new Set(items.map(x=>x.category))];
  const rows=items.map((x,i)=>[
    `### ${i+1}. ${x.category}`,'',`- **감지내용:** ${x.detail}`,`- **자동조치:** ${x.autoAction}`,`- **사용자 조치:** ${x.userAction}`,''] ).flat();
  fs.writeFileSync(REVIEW_FILE,[
    '# 공휴일 자동검증 검토 필요','',`감지일: ${todayKST()} (KST)`,`분류: **${categories.join(' / ')}**`,'',
    '자동 반영 안전조건을 충족하지 않아 애매한 변경은 학교 프로그램에 배포하지 않았습니다.','',...rows,
    '확인 위치: 이 저장소의 **Issues** 탭','','검토 완료 후 필요한 경우 공휴일 계산규칙 또는 중앙 패치만 수정하면 됩니다.'
  ].join('\n')+'\n');
}
function writeStatus(items,approved){
  const categories=[...new Set(items.map(x=>x.category))],reviewRequired=items.length>0;
  writeJSON(STATUS_FILE,{
    schema:'after-school-holiday-monitor-status-v1',
    status:reviewRequired?'review-required':'normal',
    checkedAt:todayKST(),
    summary:reviewRequired?`검토 필요 ${items.length}건 · 기존 공휴일 자료 유지`:'정상 · 검토 필요 항목 없음',
    categories,
    items,
    autoApplied:(approved||[]).map(x=>({date:x.date,name:x.name})),
    issuePage:ISSUE_PAGE
  });
}

async function main(){
  const patch=readJSON(PATCH_FILE),state=readJSON(STATE_FILE),heartbeat=readJSON(HEARTBEAT_FILE),now=kstNow(),currentYear=now.getFullYear();
  const years=[];for(let y=currentYear;y<=Math.min(MAX_YEAR,currentYear+3);y++)years.push(y);
  const review=[];

  const previousLaw=state.sources?.law||{};
  const lawResult=await tryFetchText(LAW_URL,'국가법령정보센터',2);
  let lawAvailable=false,lawHash=previousLaw.hash||'',lawChanged=false,lawError='';
  if(lawResult.ok){
    const lawText=normalizeSourceText(lawResult.text);
    if(lawText.includes('관공서의 공휴일에 관한 규정')&&lawText.includes('대체공휴일')){
      lawAvailable=true;
      lawHash=sha256(lawText);
      lawChanged=!!(state.initialized&&previousLaw.hash&&previousLaw.hash!==lawHash);
      if(lawChanged)review.push(reviewItem('법령변경','국가법령정보센터의 「관공서의 공휴일에 관한 규정」 본문 변경을 감지했습니다.','개정된 조문과 시행일을 확인한 뒤 프로그램 공휴일 계산규칙 변경이 필요한지 검토하세요.'));
    }else{
      lawError='공휴일 규정 본문 확인 실패';
      review.push(reviewItem('공식자료 확인 지연','국가법령정보센터에는 접속했지만 공휴일 규정 본문을 정상적으로 확인하지 못했습니다.','다음 자동검증에서 다시 확인합니다. 그동안 기존 공휴일 자료는 그대로 유지됩니다.'));
    }
  }else{
    lawError=lawResult.error;
    review.push(reviewItem('공식자료 연결 지연','국가법령정보센터가 GitHub 자동검증 서버의 요청에 일시적으로 응답하지 않았습니다.','별도 조치 없이 다음 자동검증을 기다리셔도 됩니다. 한국천문연구원 자료 검증은 계속 진행합니다.'));
  }

  const nextYears={...state.years},observedAdditions=[],patchMap=currentPatchMap(patch);
  let successfulYears=0;
  for(const year of years){
    const previous=state.years?.[year]||{};
    const [almanacResult,calendarResult]=await Promise.all([
      tryFetchText(KASI_ALMANAC(year),`한국천문연구원 ${year}년 월력요항`,2),
      tryFetchText(KASI_CALENDAR(year),`한국천문연구원 ${year}년 달력자료`,2)
    ]);

    if(!almanacResult.ok||!calendarResult.ok){
      const failed=[];
      if(!almanacResult.ok)failed.push('월력요항');
      if(!calendarResult.ok)failed.push('달력자료');
      review.push(reviewItem('공식자료 연결 지연',`${year}년 한국천문연구원 ${failed.join('·')} 확인이 일시적으로 지연되고 있습니다.`,'다음 자동검증에서 자동으로 다시 확인합니다. 확인 전에는 기존 자료를 유지합니다.'));
      nextYears[year]={...previous,lastChecked:todayKST(),available:false,lastError:[almanacResult.error,calendarResult.error].filter(Boolean).join(' / ')};
      continue;
    }

    successfulYears++;
    const alm=almanacStatus(almanacResult.text,year),parsed=parseKasiHolidayTable(calendarResult.text,year),calendarHash=sha256(JSON.stringify(parsed.holidays));
    const sourceChanged=!!(state.initialized&&previous.calendarHash&&previous.calendarHash!==calendarHash),officialBecameAvailable=!!(state.initialized&&!previous.official&&alm.official);
    nextYears[year]={official:alm.official,almanacHash:alm.hash,calendarHash,parseOk:parsed.ok,holidayCount:Object.keys(parsed.holidays).length,observedHolidayMap:parsed.holidays,lastChecked:todayKST(),available:true,lastError:''};

    if(!parsed.ok){
      review.push(reviewItem('공식자료 불일치',`${year}년 한국천문연구원 달력자료를 정상적인 공휴일 표로 해석하지 못했습니다. (${parsed.reason||'파싱 신뢰도 부족'})`,'한국천문연구원 페이지 구조 변경 또는 자료 오류 여부를 확인하고 자동검증기 파싱규칙을 점검하세요.'));
      continue;
    }
    if(!state.initialized||!(sourceChanged||officialBecameAvailable))continue;

    const prevObserved=previous.observedHolidayMap||{};
    if(sourceChanged){
      for(const [date,name] of Object.entries(parsed.holidays))if(!prevObserved[date]&&!patchMap[date])observedAdditions.push({year,date,name,official:alm.official,reason:'source-changed'});
      for(const [date,oldName] of Object.entries(prevObserved)){
        const nextName=parsed.holidays[date];
        if(!nextName&&(patchMap[date]||safeAutoName(oldName)))review.push(reviewItem('삭제감지',`${year}년 공식자료에서 기존 공휴일 ${date}(${oldName})가 보이지 않습니다.`,'공식 월력요항과 법령에서 실제 삭제인지 확인하세요. 확인 전에는 기존 공휴일을 유지합니다.'));
        else if(nextName&&nextName!==oldName&&(safeAutoName(oldName)||safeAutoName(nextName)))review.push(reviewItem('공식자료 불일치',`${year}년 ${date} 공휴일 명칭이 '${oldName}' → '${nextName}'으로 달라졌습니다.`,'공식 명칭 변경인지 단순 표기 차이인지 확인하세요. 확인 전에는 기존 명칭을 유지합니다.'));
      }
    }
    if(officialBecameAvailable){
      for(const [date,name] of Object.entries(parsed.holidays))if(!patchMap[date]&&/선거일|임시공휴일/.test(name))observedAdditions.push({year,date,name,official:true,reason:'official-became-available'});
    }
  }

  let approved=[];
  if(lawAvailable&&!lawChanged){
    for(const c of observedAdditions){
      if(!c.official){
        review.push(reviewItem('공식자료 불일치',`${c.date} ${c.name}가 달력자료에서 새로 감지됐지만 해당 연도의 공식 월력요항 게재가 확인되지 않았습니다.`,'공식 월력요항 발표 후 다시 확인하세요. 발표 전에는 자동 적용하지 않습니다.'));
        continue;
      }
      if(!safeAutoName(c.name)){
        review.push(reviewItem('공식자료 불일치',`${c.date} ${c.name}가 새로 감지됐지만 안전 자동추가 범주(임시공휴일·선거일·대체공휴일)에 해당하지 않습니다.`,'법령 또는 공식 발표에서 새 공휴일인지 확인한 뒤 계산규칙 또는 중앙 패치를 검토하세요.'));
        continue;
      }
      approved.push(c);
    }
  }else if(observedAdditions.length){
    review.push(reviewItem('자동반영 보류',`신규 공휴일 후보 ${observedAdditions.length}건을 감지했지만 국가법령정보센터 확인이 완료되지 않아 자동반영을 보류했습니다.`,'다음 자동검증에서 법령 확인까지 완료되면 안전조건에 따라 다시 판단합니다.'));
  }

  approved=[...new Map(approved.map(x=>[x.date,x])).values()];
  if(approved.length>MAX_AUTO_ADDITIONS){
    review.push(reviewItem('다량변경',`한 번에 ${approved.length}건의 신규 공휴일이 감지되어 안전한 자동 반영 한도(${MAX_AUTO_ADDITIONS}건)를 초과했습니다.`,'공식자료에 대규모 개정이 있었는지 확인하고 변경 건 전체를 검토하세요.','신규 공휴일 자동추가를 전부 보류하고 기존 중앙 패치를 유지합니다.'));
    approved=[];
  }

  if(state.initialized&&approved.length){
    const existing=new Map((patch.holidays||[]).map(r=>[r.date,r]));
    for(const c of approved)existing.set(c.date,{date:c.date,name:c.name,action:'set',mode:'replace'});
    patch.schema='after-school-holidays-v1';patch.version=versionForToday(patch.version);patch.referenceDate=todayKST();patch.source='공식자료 자동검증 중앙 공휴일 패치';
    patch.holidays=[...existing.values()].sort((a,b)=>a.date.localeCompare(b.date));patch.removeDates=Array.isArray(patch.removeDates)?patch.removeDates:[];
    patch.verification={mode:'automatic-confirmed-only',checkedAt:todayKST(),sources:['국가법령정보센터','한국천문연구원 월력요항','한국천문연구원 달력자료'],autoAdded:approved.map(x=>({date:x.date,name:x.name}))};
    writeJSON(PATCH_FILE,patch);console.log(`[AUTO-PATCH] ${approved.length}건 적용:`,approved);
  }

  const nextInitialized=!!(state.initialized||successfulYears>0);
  const nextState={
    schema:'after-school-holiday-source-state-v1',
    initialized:nextInitialized,
    sources:{
      ...(state.sources||{}),
      law:{url:LAW_URL,hash:lawHash,available:lawAvailable,lastChecked:todayKST(),lastError:lawError}
    },
    years:nextYears,
    lastResult:{date:todayKST(),autoApplied:approved.map(x=>({date:x.date,name:x.name})),reviewRequired:review.length>0,categories:[...new Set(review.map(x=>x.category))],successfulYears}
  };
  const meaningfulChanged=JSON.stringify({...state,lastResult:undefined})!==JSON.stringify({...nextState,lastResult:undefined});
  if(!state.initialized||meaningfulChanged||approved.length||review.length)writeJSON(STATE_FILE,nextState);
  if(heartbeat.month!==monthKST())writeJSON(HEARTBEAT_FILE,{schema:'after-school-holiday-heartbeat-v1',month:monthKST(),checkedBy:'GitHub Actions'});
  writeStatus(review,approved);writeReview(review);
  console.log(`[DONE] initialized=${nextInitialized} successfulYears=${successfulYears} lawAvailable=${lawAvailable} approved=${approved.length} review=${review.length}`);
}

main().catch(error=>{
  console.error(error);
  try{
    writeJSON(STATUS_FILE,{schema:'after-school-holiday-monitor-status-v1',status:'error',checkedAt:todayKST(),summary:'자동검증 프로그램 내부 오류',categories:['자동검증 프로그램 오류'],items:[reviewItem('자동검증 프로그램 오류',String(error?.message||error),'자동검증 코드 자체의 오류이므로 GitHub Actions 실행 로그를 확인하세요.')],autoApplied:[],issuePage:ISSUE_PAGE});
  }catch{}
  process.exit(1);
});