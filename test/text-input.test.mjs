import test from 'node:test';
import assert from 'node:assert/strict';
import {bindCommittedTextInput,trackComposition} from '../dist/text-input.js';
class Input extends EventTarget {value='';}
function emit(input,type,value,composing=false){
  if(value!==undefined)input.value=value;
  const event=new Event(type);Object.defineProperty(event,'isComposing',{value:composing});input.dispatchEvent(event);
}
test('拼音组合阶段不筛选，选字完成后提交一次中文',()=>{
  const input=new Input(),values=[];bindCommittedTextInput(input,value=>values.push(value));
  emit(input,'compositionstart');emit(input,'input','sh',true);emit(input,'input','shang',true);emit(input,'input','上海',true);
  assert.deepEqual(values,[]);emit(input,'compositionend','上海');emit(input,'input','上海');
  assert.deepEqual(values,['上海']);assert.equal(input.value,'上海');
});
test('即使中间input未携带isComposing标记，也不会中断选字',()=>{
  const input=new Input(),values=[];bindCommittedTextInput(input,value=>values.push(value));
  emit(input,'compositionstart');emit(input,'input','kaifa');assert.deepEqual(values,[]);
  emit(input,'compositionend','开发');assert.deepEqual(values,['开发']);
});
test('连续中文、英文、粘贴与清空都更新完整值',()=>{
  const input=new Input(),values=[];bindCommittedTextInput(input,value=>values.push(value));
  emit(input,'input','AI ');emit(input,'compositionstart');emit(input,'input','AI gong',true);emit(input,'compositionend','AI 工程师');
  emit(input,'input','后端工程师');emit(input,'input','');assert.deepEqual(values,['AI ','AI 工程师','后端工程师','']);
});
test('取消组合不会提交临时拼音，解绑后不再更新',()=>{
  const input=new Input(),values=[];input.value='上海';const dispose=bindCommittedTextInput(input,value=>values.push(value));
  emit(input,'compositionstart');emit(input,'input','上海java',true);emit(input,'compositionend','上海');assert.deepEqual(values,[]);
  dispose();emit(input,'input','杭州');assert.deepEqual(values,[]);
});
test('后台渲染等组合结束和最后input事件完成后再执行',async()=>{
  const root=new EventTarget(),order=[];const tracker=trackComposition(root,()=>order.push('render'));
  root.dispatchEvent(new Event('compositionstart'));assert.equal(tracker.active,true);
  root.dispatchEvent(new Event('compositionend'));assert.equal(tracker.active,false);order.push('final input');assert.deepEqual(order,['final input']);
  await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(order,['final input','render']);tracker.dispose();
});
test('开始下一次组合时，暂缓上一次排队的后台渲染',async()=>{
  const root=new EventTarget();let renders=0;const tracker=trackComposition(root,()=>renders++);
  root.dispatchEvent(new Event('compositionstart'));root.dispatchEvent(new Event('compositionend'));root.dispatchEvent(new Event('compositionstart'));
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(renders,0);assert.equal(tracker.active,true);tracker.dispose();
});
