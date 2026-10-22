import { render,screen,fireEvent,waitFor,cleanup } from '@testing-library/preact';
import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { queryClient } from '../ui/src/query/client';
import { AppShellProvider } from '../ui/src/app-shell';
import { SpaceExportDialog } from '../ui/src/views/spaces/SpaceExportDialog';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';

let publications:Array<Record<string,unknown>>=[];
beforeEach(()=> {
  queryClient.clear();localStorage.clear();publications=[];__resetBrowserSessionForTests();
  vi.stubGlobal('fetch',vi.fn(async(input,init)=> {
    const url=String(input),method=init?.method ?? 'GET';
    if(url.includes('whoami'))return new Response(JSON.stringify({authenticated:true,session:{csrf_token:'csrf'}}),{status:200,headers:{'content-type':'application/json'}});
    if(url.endsWith('/publications') && method==='GET')return new Response(JSON.stringify({publications,destinations:[],history:[{id:'history',kind:'checkout-file',content:'preserved divergent bytes',artifact_ref:null,blocks_json:null,provenance_json:'{}'}]}),{status:200,headers:{'content-type':'application/json'}});
    if(url.endsWith('/publications') && method==='POST') {
      const publication={id:'prepared',path:'docs/test.md',state:'prepared',content:'selected immutable bytes',snapshot_ref:'pinned',source_revision:'hash',auth_request_id:null};
      publications.push(publication);return new Response(JSON.stringify(publication),{status:201,headers:{'content-type':'application/json'}});
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();__resetBrowserSessionForTests();});
function mount() {
  return render(<AppShellProvider value={{active:true,noticeHost:null,rightSidebar:null,registerRightSidebar:()=>()=>undefined,registerInitialRouteLoad:()=>undefined,setViewSidebarWidth:()=>undefined}}>
    <SpaceExportDialog spaceId="space" projectId="project" onClose={()=>undefined}/>
  </AppShellProvider>);
}
it('requires explicit snapshot review, and reopening preserves inputs and immutable selection',async()=> {
  const view=mount();
  await screen.findByText('Preserved documents');
  fireEvent.input(screen.getByLabelText('Destination path'),{target:{value:'docs/test.md'}});
  fireEvent.input(screen.getByLabelText('Issue'),{target:{value:'abc1234'}});
  fireEvent.click(screen.getByText('Prepare snapshot'));
  await screen.findByText('selected immutable bytes');
  expect(publications).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.some(([input])=>String(input).endsWith('/submit'))).toBe(false);
  view.unmount();mount();
  await screen.findByText('selected immutable bytes');
  expect((screen.getByLabelText('Destination path') as HTMLInputElement).value).toBe('docs/test.md');
  expect((screen.getByLabelText('Issue') as HTMLInputElement).value).toBe('abc1234');
  fireEvent.click(screen.getByText('checkout-file'));
  await waitFor(()=>expect(screen.getByText('preserved divergent bytes')).toBeTruthy());
});
