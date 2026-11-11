import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:['--no-sandbox']});
const baseURL=process.env.DASHBOARD_TEST_URL;
const context=await browser.newContext({baseURL,viewport:{width:1440,height:1000},extraHTTPHeaders:{'x-forwarded-proto':'https'}});
const [name,...rest]=process.env.DASHBOARD_TEST_COOKIE.split('=');await context.addCookies([{name,value:rest.join('='),url:baseURL,httpOnly:true,sameSite:'Lax'}]);
let jobs=[{id:'fixture',name:'Legacy scheduled task',enabled:true,schedule:{kind:'cron',expr:'0 6 * * *',tz:'America/Chicago'},sessionTarget:'isolated',wakeMode:'now',payload:{kind:'agentTurn',message:'Synthetic task',model:'example/model'},delivery:{mode:'none'},failureAlert:{after:1,delivery:{mode:'announce'},channel:'telegram'},hash:'first'}];
const saves=[];
await context.route('**/api/admin/openclaw-tasks**',async route=>{
 if(route.request().method()==='GET')return route.fulfill({json:{jobs}});
 const body=route.request().postDataJSON();saves.push(body);const id=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
 const job=jobs.find(j=>j.id===id);Object.assign(job,body.task,{hash:'saved-'+saves.length});return route.fulfill({json:job});
});
const page=await context.newPage();
try{
 await page.goto('/#openclaw/openclaw-tasks',{waitUntil:'domcontentloaded'});await page.locator('.task-list-item').first().waitFor();
 for(const job of jobs){
  await page.locator('.task-list-item').filter({has:page.getByText(job.name,{exact:true})}).click();
  const enabled=page.getByRole('switch',{name:'Enabled',exact:true});const previous=await enabled.isChecked();await enabled.setChecked(!previous);
  const before=saves.length;await page.getByRole('button',{name:'Save task',exact:true}).click();await page.waitForTimeout(150);
  if(saves.length===before)console.log('UNSAVED',job.name,await page.locator('.task-form').evaluate(form=>[...form.elements].filter(x=>x.validity&&!x.validity.valid).map(x=>({label:x.getAttribute('aria-label'),type:x.type,value:x.value,error:x.validationMessage}))),await page.locator('.editor-status').first().textContent());
  assert.equal(saves.length,before+1,'toggle-only save sends '+job.name);
  await page.locator('.dashboard-toast').getByRole('button',{name:'Undo',exact:true}).click();
  await page.getByText('Changes undone',{exact:true}).waitFor();
  assert.equal(await enabled.isChecked(),previous,'undo restores enabled');
  await enabled.setChecked(!previous);await page.getByRole('button',{name:'Save task',exact:true}).click();
  await page.getByText('Task changes saved',{exact:true}).waitFor();
  await page.waitForTimeout(5250);assert.equal(await page.locator('.dashboard-toast').count(),0,'alert and undo expire together after five seconds');
 }
 console.info('Task toggle, saved notification, Undo, and five-second expiry passed.');
}finally{await browser.close()}
