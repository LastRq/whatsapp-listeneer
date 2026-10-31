import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseClient, listenerTenantId, FIREBASE_PROJECT_ID} from '../src/firebase-client.js';
import {sessionDocumentId,sessionDocumentBelongsTo,safeSessionFileName} from '../src/listener-scope.js';
import {statusCors,publicListenerStatus} from '../src/http-status.js';
test('only the official Firebase project is used',()=>assert.equal(FIREBASE_PROJECT_ID,'kindevads'));
test('invalid tenant identifiers cannot form paths',()=>{
 for(const id of ['../kindev','a/b','','a?b'])assert.throws(()=>listenerTenantId(id));
 assert.equal(listenerTenantId('cliente_a'),'cliente_a');
});
test('session prefixes cannot overlap even for ids containing underscores',()=>{
 const a=sessionDocumentId('creds.json','cliente'),b=sessionDocumentId('creds.json','cliente_a');
 assert.notEqual(a,b);assert.equal(sessionDocumentBelongsTo(b,'cliente'),false);assert.equal(sessionDocumentBelongsTo(a,'cliente_a'),false);
});
test('session filenames are constrained to the cache directory',()=>{
 assert.equal(safeSessionFileName('../creds.json'),null);assert.equal(safeSessionFileName('a\\creds.json'),null);
 assert.equal(safeSessionFileName('a/b:c.json'),'a__b-c.json');
});
test('a connectedUser left behind after disconnection cannot report an active socket',()=>{
 const status=publicListenerStatus({status:'desconectado_logout',phone:'masked',tenantId:'kindev',projectId:'kindevads'});
 assert.equal(status.connected,false);assert.equal(status.isListening,false);assert.equal(status.phone,null);
});
test('public status binds the socket to its account and project',()=>{
 const status=publicListenerStatus({status:'conectado',phone:'+593 *** *** 000',tenantId:'cliente_a',projectId:'kindevads',now:0});
 assert.equal(status.connected,true);assert.equal(status.tenantId,'cliente_a');assert.equal(status.updatedAt,'1970-01-01T00:00:00.000Z');
});
test('CORS exposes only status to the official application, not QR or session actions',()=>{
 for(const [origin,path,expected] of [['https://kindevads.com','/api/status',true],['https://attacker.example','/api/status',false],['https://kindevads.com','/qr',false],['https://kindevads.com','/api/session/reset',false]]){
  const headers={};let called=false;
  statusCors({path,method:'GET',headers:{origin}},{setHeader:(k,v)=>headers[k]=v},()=>called=true);
  assert.equal(Boolean(headers['Access-Control-Allow-Origin']),expected);assert.equal(called,true);
 }
});
test('foreign Firebase URLs are rejected before authentication or a network request',async()=>{
 let calls=0;const client=createFirebaseClient({fetcher:async()=>{calls++;throw Error('Unexpected network');}});
 await assert.rejects(()=>client.request('https://firestore.googleapis.com/v1/projects/kindevmetaads/databases/(default)/documents/settings/x'));
 assert.equal(calls,0);
});
test('parallel requests share one sign-in and send the token only to official Firestore',async()=>{
 let auth=0,reads=0;
 const client=createFirebaseClient({fetcher:async(url,options)=>{
  if(url.startsWith('https://identitytoolkit.googleapis.com')){auth++;await Promise.resolve();return new Response(JSON.stringify({idToken:'test-id-token',refreshToken:'test-refresh',expiresIn:3600}),{status:200});}
  assert.ok(url.includes('/projects/kindevads/'));assert.equal(options.headers.Authorization,'Bearer test-id-token');reads++;return new Response('{}',{status:200});
 }});
 const url='https://firestore.googleapis.com/v1/projects/kindevads/databases/(default)/documents/settings/whatsapp_status_kindev';
 await Promise.all([client.request(url),client.request(url)]);assert.equal(auth,1);assert.equal(reads,2);
});
