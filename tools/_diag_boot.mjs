const CORDIS='file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/cordis/lib/index.js'
const SYS='file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
const TOOLS='file:///E:/DSH-desktop/DeepSeek Harness/data/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const { Context } = await import(CORDIS)
const { default: SystemPrompt } = await import(SYS)
const { default: ToolRuntime, defineTool } = await import(TOOLS)
const tick=()=>new Promise(r=>setTimeout(r,120))
const root=new Context()
try{
  root.plugin({ name:'boot', apply(ctx){ 
    try { new SystemPrompt(ctx); console.log('SystemPrompt ok') } catch(e){ console.log('SystemPrompt THREW:', e.message) }
    try { new ToolRuntime(ctx,{mode:'native'}); console.log('ToolRuntime ok') } catch(e){ console.log('ToolRuntime THREW:', e.message) }
  }})
}catch(e){ console.log('plugin THREW:', e.message) }
await tick()
console.log('root.tools?', root.tools===undefined?'undefined':'present')
console.log('root.systemPrompt?', root.systemPrompt===undefined?'undefined':'present')
try { await root.inject(['tools'], async (ctx)=>{ console.log('inject callback ran; ctx.tools=', ctx.tools===undefined?'undefined':'present') }) } catch(e){ console.log('inject THREW:', e.message) }
console.log('after inject tick')
await tick()
