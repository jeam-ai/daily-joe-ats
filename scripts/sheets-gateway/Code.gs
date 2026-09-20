/* Daily Joe Careers transaction gateway. Deploy as the careers account.
 * Set DJC_SECRET, DJC_SPREADSHEET_ID and DJC_PRIVATE_FOLDER_ID in Script
 * Properties. Enable the Google Sheets advanced service. Never put credentials
 * in workbook cells. The web endpoint authenticates every request with HMAC.
 */
const DJC_TABLES = ['records','audit_logs','resumes','users','applicants','hiring_needs','applications','intake_window','interviews','application_requirements','screening_results','employment_records','application_events','qualification_templates','requirements','email_templates','locations','notifications'];
function initializeStorage() {
  const props=PropertiesService.getScriptProperties(), id=props.getProperty('DJC_SPREADSHEET_ID');
  if(!id)throw Error('Set DJC_SPREADSHEET_ID in Project Settings first.');
  Sheets.Spreadsheets.get(id,{fields:'spreadsheetId'});
  if(!props.getProperty('DJC_PRIVATE_FOLDER_ID'))props.setProperty('DJC_PRIVATE_FOLDER_ID',DriveApp.createFolder('Daily Joe Careers — Private Storage').getId());
  // The owner enters DJC_SECRET through Project Settings. Never print it.
}
function djcJson(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
// Private API Executable transport for organizations that prohibit public web apps.
function executeGateway(envelope) {return JSON.parse(doPost({postData:{contents:JSON.stringify(envelope)}}).getContent());}
function djcHex(bytes) {return bytes.map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2)}).join('');}
function doPost(e) {
  try {
    const envelope=JSON.parse(e.postData.contents), props=PropertiesService.getScriptProperties();
    const secret=props.getProperty('DJC_SECRET');
    if(!secret||secret.length<32||typeof envelope.payload!=='string'||typeof envelope.signature!=='string')return djcJson({ok:false,code:'unauthorized'});
    const expected=djcHex(Utilities.computeHmacSha256Signature(envelope.payload,secret));
    let diff=expected.length^envelope.signature.length;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^envelope.signature.charCodeAt(i);
    const request=JSON.parse(envelope.payload);
    if(diff||typeof request.at!=='number'||!Number.isFinite(request.at)||Math.abs(Date.now()-request.at)>120000)return djcJson({ok:false,code:'unauthorized'});
    const lock=LockService.getScriptLock();if(!lock.tryLock(20000))return djcJson({ok:false,code:'busy'});
    try {return djcJson({ok:true,data:djcOperation(request,props)});} finally {lock.releaseLock();}
  } catch(error) {return djcJson({ok:false,code:['conflict','unverified','schema','integrity'].includes(error.message)?error.message:'operation_failed'});}
}
function djcState(id) {
  const values=Sheets.Spreadsheets.Values.get(id,"'Sync Status and System Health'!S1:V1").values;
  const cell=values&&values[0]||[];
  return {revision:Number(cell[0]||0),manifest:cell[1]||'',verified:cell[2]==='Verified',commit:cell[3]||''};
}
function djcManifest(state) {return state.manifest?JSON.parse(DriveApp.getFileById(state.manifest).getBlob().getDataAsString()):{blobs:{},receipts:[],migration:null};}
function djcLoadRows(id,tab,cached) {
  const values=cached&&cached[tab] || Sheets.Spreadsheets.Values.get(id,"'"+tab.replace(/'/g,"''")+"'!A2:Q").values||[];
  const grouped={};values.forEach(function(r,index){if(!r[0])return;const key=r[0];grouped[key]=grouped[key]||[];grouped[key].push({part:Number(r[7]),parts:Number(r[8]),json:r[9],number:index+2});});
  return {values:values,groups:grouped};
}
function djcDecode(parts) {parts.sort(function(a,b){return a.part-b.part});if(parts.length!==parts[0].parts||parts.some(function(p,i){return p.part!==i+1}))throw Error('integrity');return JSON.parse(parts.map(function(p){return p.json}).join(''));}
function djcPrivateRow(ref,cache) {if(!Object.prototype.hasOwnProperty.call(cache,ref.fileId))cache[ref.fileId]=JSON.parse(DriveApp.getFileById(ref.fileId).getBlob().getDataAsString());const value=cache[ref.fileId];if(ref.batchKey&&(!value.rows||!Object.prototype.hasOwnProperty.call(value.rows,ref.batchKey)))throw Error('integrity');return ref.batchKey?value.rows[ref.batchKey]:value;}
function djcOperation(r,props,snapshot) {
  const id=props.getProperty('DJC_SPREADSHEET_ID'),folderId=props.getProperty('DJC_PRIVATE_FOLDER_ID');
  if(!id||!folderId)throw Error('schema');
  const state=snapshot?snapshot.state:djcState(id),manifest=snapshot?snapshot.manifest:djcManifest(state);
  if(r.operation==='status')return {revision:state.revision,verified:state.verified,spreadsheetId:id,migration:manifest.migration};
  if(r.operation==='loadMany') {
    if(!Array.isArray(r.queries)||r.queries.length>50||r.queries.some(function(q){return !DJC_TABLES.includes(q.table)}))throw Error('schema');
    const tabs=Array.from(new Set(r.queries.flatMap(function(q){return q.tab?[q.tab]:q.tabs||[]})));
    const cache={},privateCache={};
    if(tabs.length){const result=Sheets.Spreadsheets.Values.batchGet(id,{ranges:tabs.map(function(tab){return "'"+tab.replace(/'/g,"''")+"'!A2:Q"})});tabs.forEach(function(tab,i){cache[tab]=result.valueRanges[i].values||[]});}
    return {revision:state.revision,results:r.queries.map(function(q){return djcOperation(Object.assign({},q,{operation:'load'}),props,{state:state,manifest:manifest,rows:cache,privateRows:privateCache}).rows})};
  }
  if(r.operation==='load') {
    if(!DJC_TABLES.includes(r.table))throw Error('schema');
    const match=function(row){return (!r.collection||row.collection===r.collection)&&(!r.id||String(row.id||row.application_id)===r.id)};
    let rows=[];const privateCache=snapshot&&snapshot.privateRows||{};
    (r.tab?[r.tab]:r.tabs||[]).forEach(function(tab){const loaded=djcLoadRows(id,tab,snapshot&&snapshot.rows);Object.keys(loaded.groups).forEach(function(key){if(JSON.parse(key)[0]!==r.table)return;const parts=loaded.groups[key];const row=djcDecode(parts);if(match(row))rows.push(row)});});
    Object.keys(manifest.blobs).forEach(function(key){const ref=manifest.blobs[key];if(ref.table===r.table&&match(ref.metadata)){if(r.metadataOnly)rows.push(ref.metadata);else {const row=djcPrivateRow(ref,privateCache);if(row)rows.push(row);}}});
    return {revision:state.revision,rows:rows};
  }
  if(r.operation==='commit') {
    if(manifest.receipts.includes(r.commitId))return {revision:state.revision,replayed:true};
    if(r.expectedRevision!==state.revision)throw Error('conflict');
    if(!r.migration&&!state.verified)throw Error('unverified');
    if(!Array.isArray(r.changes)||r.changes.length>5000)throw Error('schema');
    const folder=DriveApp.getFolderById(folderId),metadata=Sheets.Spreadsheets.get(id,{fields:'sheets.properties'}),tabs={};
    metadata.sheets.forEach(function(s){tabs[s.properties.title]=s.properties});
    const requests=[],loaded={},next={},privateRows={},privateRefs=[];
    r.changes.forEach(function(change){
      if(!DJC_TABLES.includes(change.table)||typeof change.key!=='string')throw Error('schema');
      let document={};try{document=JSON.parse(change.row&&change.row.payload||'{}')}catch(ignored){}
      const privateCollections=['secure','tracker','import_previews','spreadsheet_import_previews','application_sources','timekeeping_inputs','odoo_sources','odoo_uploads','email_drafts','email_outbox','ai_runs','extraction_results'];
      const secret=change.table==='resumes'||(change.row&&privateCollections.includes(change.row.collection))||document.isDemo===true||document.source==='Demo';
      if(secret&&!change.private)throw Error('schema');
      if(change.private){if(change.deleted)delete manifest.blobs[change.key];else {const summary={};['id','application_id','collection','sha256','filename','mime'].forEach(function(k){if(change.row[k]!==undefined)summary[k]=change.row[k]});privateRows[change.key]=change.row;privateRefs.push({key:change.key,table:change.table,metadata:summary});}return;}
      const tab=change.tab,property=tabs[tab];if(!property)throw Error('schema');
      if(!loaded[tab]){loaded[tab]=djcLoadRows(id,tab);next[tab]=loaded[tab].values.length+2;}
      const old=loaded[tab].groups[change.key]||[],cells=change.deleted?[]:change.cells;
      if(!Array.isArray(cells)||cells.some(function(row){return row[0]!==change.key||row[1]!==change.table||row.length>17}))throw Error('schema');
      const count=Math.max(old.length,cells.length);
      for(let i=0;i<count;i++){const number=old[i]?old[i].number:next[tab]++;const values=cells[i]||Array(17).fill('');requests.push({updateCells:{range:{sheetId:property.sheetId,startRowIndex:number-1,endRowIndex:number,startColumnIndex:0,endColumnIndex:17},rows:[{values:values.map(function(v){return {userEnteredValue:typeof v==='number'?{numberValue:v}:typeof v==='boolean'?{boolValue:v}:{stringValue:String(v)}}})}],fields:'userEnteredValue'}});}
    });
    // One immutable Drive blob per commit keeps bulk uploads bounded while the
    // manifest still addresses each protected record by its stable key.
    if(privateRefs.length){const privateFile=folder.createFile(Utilities.newBlob(JSON.stringify({version:1,rows:privateRows}),'application/json','private-batch-'+Utilities.getUuid()+'.json'));privateRefs.forEach(function(ref){manifest.blobs[ref.key]={fileId:privateFile.getId(),batchKey:ref.key,table:ref.table,metadata:ref.metadata};});}
    Object.keys(next).forEach(function(tab){if(next[tab]>tabs[tab].gridProperties.rowCount)requests.unshift({appendDimension:{sheetId:tabs[tab].sheetId,dimension:'ROWS',length:next[tab]-tabs[tab].gridProperties.rowCount+100}})});
    manifest.receipts=[r.commitId].concat(manifest.receipts).slice(0,200);
    if(r.verification){manifest.migration=r.verification;}
    const file=folder.createFile(Utilities.newBlob(JSON.stringify(manifest),'application/json','manifest-'+Utilities.getUuid()+'.json'));
    const control=tabs['Sync Status and System Health'];
    if(control.gridProperties.columnCount<22)requests.unshift({appendDimension:{sheetId:control.sheetId,dimension:'COLUMNS',length:22-control.gridProperties.columnCount}});
    requests.push({updateCells:{range:{sheetId:control.sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:18,endColumnIndex:22},rows:[{values:[{userEnteredValue:{numberValue:state.revision+1}},{userEnteredValue:{stringValue:file.getId()}},{userEnteredValue:{stringValue:r.verification&&r.verification.verified?'Verified':state.verified?'Verified':'Pending'}},{userEnteredValue:{stringValue:r.commitId}}]}],fields:'userEnteredValue'}});
    // One atomic Sheets batch commits operational rows and the immutable private
    // blob manifest pointer. Interrupted staging leaves harmless private files.
    Sheets.Spreadsheets.batchUpdate({requests:requests},id);
    return {revision:state.revision+1};
  }
  throw Error('schema');
}
