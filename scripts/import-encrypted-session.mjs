import { firestoreFetch } from '../src/firebase-client.js';
import { sessionDocumentId, safeSessionFileName } from '../src/listener-scope.js';
const args=process.argv.slice(2);
const sourceProject=args[args.indexOf('--from')+1];
const tenant=args[args.indexOf('--tenant')+1];
const apply=args.includes('--apply');
if(!args.includes('--from')||!args.includes('--tenant')||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(sourceProject)||!tenant)throw Error('Use --from PROJECT --tenant ACCOUNT [--apply]');
if(sourceProject==='kindevads')throw Error('Source must be different from the target.');
const records=new Map();
let page='';
do {
 const params=new URLSearchParams({pageSize:'300'});
 for(const name of ['fileName','data','encrypted','updatedAt'])params.append('mask.fieldPaths',name);
 if(page)params.set('pageToken',page);
 const response=await fetch('https://firestore.googleapis.com/v1/projects/'+sourceProject+'/databases/(default)/documents/settings?'+params,{signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error('Cannot read source session: HTTP '+response.status);
 const body=await response.json();
 for(const doc of body.documents||[]){
  const id=doc.name.split('/').pop();
  if(!id.startsWith('whatsapp_status_session_')&&!id.startsWith('whatsapp_session_'))continue;
  const name=doc.fields?.fileName?.stringValue;
  if(!safeSessionFileName(name))continue;
  const payload=doc.fields?.data?.stringValue;
  if(!payload?.startsWith('enc:')||doc.fields?.encrypted?.booleanValue!==true)throw Error('Source contains a session file that is not encrypted; import stopped.');
  const prior=records.get(name);
  if(!prior||String(doc.updateTime)>String(prior.updateTime))records.set(name,doc);
 }
 page=body.nextPageToken||'';
}while(page);
if(!records.has('creds.json'))throw Error('No encrypted credentials found. No files were written.');
console.log(JSON.stringify({mode:apply?'import':'read-only',sourceProject,targetProject:'kindevads',tenant,encryptedSessionFiles:records.size,credentialsPresent:true}));
if(!apply)process.exit(0);
let imported=0,existing=0;
for(const [name,record]of records){
 const url='https://firestore.googleapis.com/v1/projects/kindevads/databases/(default)/documents/settings/'+sessionDocumentId(name,tenant);
 const current=await firestoreFetch(url);
 if(current.ok){existing++;continue;}
 if(current.status!==404)throw Error('Target lookup failed: HTTP '+current.status);
 const fields={...record.fields,tenantId:{stringValue:tenant},migratedAt:{stringValue:new Date().toISOString()}};
 const response=await firestoreFetch(url+'?currentDocument.exists=false',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields})});
 if(response.status===409||response.status===412){existing++;continue;}
 if(!response.ok)throw Error('Target import failed: HTTP '+response.status);
 imported++;
 if(imported%50===0)console.log(JSON.stringify({imported,existing}));
}
console.log(JSON.stringify({imported,existing,sourceModified:false,plaintextSessionWritten:false}));
