'use strict';
/* Windows built-in .NET System.Speech recognition.
   One-shot on explicit click, Russian language pack required. No cloud API key.
   No user text is ever injected into a PowerShell command. */
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const SYSTEM_SPEECH_SCRIPT=`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Speech
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $russian = $installed | Where-Object { $_.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
  if ($null -eq $russian) {
    [Console]::WriteLine('{"ok":false,"code":"language","message":"Установите русский пакет распознавания речи Windows или введите команду текстом."}')
    exit 0
  }
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($russian)
  try {
    $grammar = [System.Speech.Recognition.DictationGrammar]::new()
    $engine.LoadGrammar($grammar)
    $engine.SetInputToDefaultAudioDevice()
    $result = $engine.Recognize([TimeSpan]::FromSeconds(10))
    if ($null -eq $result) {
      [Console]::WriteLine('{"ok":false,"code":"no-speech","message":"Не расслышал команду. Попробуйте ещё раз."}')
    } else {
      $output = @{ok=$true;text=$result.Text;confidence=$result.Confidence}
      [Console]::WriteLine(($output | ConvertTo-Json -Compress))
    }
  } finally { $engine.Dispose() }
} catch {
  [Console]::WriteLine('{"ok":false,"code":"device","message":"Распознавание речи Windows недоступно. Проверьте микрофон и языковой пакет."}')
}
`;
// A packaged Vosk model works without Windows language packs or API keys.
// System.Speech remains a last-resort fallback only for unbundled developer builds.
function offlinePaths(root=process.resourcesPath||path.join(__dirname,'..')){
 const base=path.join(root,'speech');
 return {
  worker:path.join(base,'mpol-speech','mpol-speech.exe'),
  model:path.join(base,'vosk-model-small-ru-0.22')
 };
}
function startOfflineRecognition({platform=process.platform,spawnProcess=spawn,
  workerPath,modelPath,timeoutMs=21000}={}){
 if(platform!=='win32')return {promise:Promise.resolve({
  ok:false,code:'platform',message:'Локальное распознавание доступно на Windows.'
 }),cancel(){}};
 const paths=offlinePaths();
 const binary=workerPath||paths.worker,model=modelPath||paths.model;
 if(!fs.existsSync(binary)||!fs.existsSync(model))return {promise:Promise.resolve({
  ok:false,code:'missing-model',
  message:'Русский речевой модуль отсутствует в приложении. Переустановите MPOL Messenger.'
 }),cancel(){}};
 let child=null,done=false,timer=null,complete=()=>{};
 const promise=new Promise(resolve=>{
  complete=value=>{if(done)return;done=true;if(timer)clearTimeout(timer);resolve(value)};
  try{
   child=spawnProcess(binary,['--model',model,'--max-seconds','9'],{
    windowsHide:true,stdio:['ignore','pipe','pipe']
   });
  }catch(e){
   complete({ok:false,code:'engine',message:'Не удалось запустить голосовой модуль MPOL.'});
   return;
  }
  const buffers=[];let bytes=0;
  child.stdout?.on('data',chunk=>{
   const b=Buffer.from(chunk);bytes+=b.length;
   if(bytes<=16000)buffers.push(b);
  });
  child.stderr?.on('data',()=>{});
  child.on('error',()=>complete({ok:false,code:'engine',message:'Ошибка запуска голосового модуля MPOL.'}));
  child.on('close',()=>{
   if(done)return;
   const output=Buffer.concat(buffers).toString('utf8').trim();
   const last=output.split(/\r?\n/).filter(Boolean).pop()||'';
   let result;try{result=JSON.parse(last)}catch{}
   if(result?.ok && typeof result.text==='string' && result.text.trim()){
    complete({
     ok:true,text:result.text.trim().slice(0,160),
     alternatives:Array.isArray(result.alternatives)?
      result.alternatives.filter(x=>typeof x==='string').slice(0,6).map(x=>x.slice(0,160)):[],
     engine:'offline'
    });
   }else if(result?.ok===false){
    complete({ok:false,code:String(result.code||'engine'),
     message:String(result.message||'Не удалось распознать голос.').slice(0,260)});
   }else complete({ok:false,code:'engine',message:'Голосовой модуль не вернул распознанную команду.'});
  });
  timer=setTimeout(()=>{
   try{child?.kill()}catch{}
   complete({ok:false,code:'timeout',message:'Время голосовой команды истекло.'});
  },timeoutMs);
 });
 return {promise,cancel(){
  try{child?.kill()}catch{}
  complete({ok:false,code:'cancelled',message:'Прослушивание остановлено.'});
 }};
}
function startNativeRecognition(options={}){
 const locations=offlinePaths();
 const worker=options.workerPath??locations.worker;
 const model=options.modelPath??locations.model;
 if(fs.existsSync(worker)&&fs.existsSync(model))
  return startOfflineRecognition({...options,workerPath:worker,modelPath:model});
 return startSystemSpeechRecognition(options);
}
function startSystemSpeechRecognition({platform=process.platform,spawnProcess=spawn}={}){
 if(platform!=='win32')return {promise:Promise.resolve({
  ok:false,code:'platform',message:'Системное распознавание доступно только в Windows.'
 }),cancel(){}};
 let child=null,done=false,finish;
 const promise=new Promise(resolve=>{
  finish=result=>{if(done)return;done=true;clearTimeout(timeout);resolve(result)};
  const command=Buffer.from(SYSTEM_SPEECH_SCRIPT,'utf16le').toString('base64');
  try{
   child=spawnProcess('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',command],{
     windowsHide:true,stdio:['ignore','pipe','pipe'],
     env:{...process.env,POWERSHELL_TELEMETRY_OPTOUT:'1'}
    });
  }catch{resolve({ok:false,code:'unavailable',message:'Не удалось запустить распознавание Windows.'});done=true;return}
  let out='';
  child.stdout?.on('data',b=>{out=(out+String(b)).slice(-12000)});
  child.stderr?.on('data',()=>{});
  child.on('error',()=>finish({ok:false,code:'unavailable',
    message:'Встроенное распознавание Windows недоступно.'}));
  child.on('close',()=>{
   if(done)return;
   const last=out.trim().split(/\r?\n/).filter(Boolean).pop()||'';
   let result;
   try{result=JSON.parse(last)}catch{}
   if(result?.ok&&typeof result.text==='string'){
    const recognized=result.text.trim().slice(0,160);
    finish(recognized?{ok:true,text:recognized}:{ok:false,code:'no-speech',message:'Команда не распознана.'});
   }else if(result?.ok===false){
    finish({ok:false,code:result.code||'unavailable',message:String(result.message||'Распознавание недоступно.')});
   }else finish({ok:false,code:'unavailable',message:'Распознавание Windows не смогло обработать голос.'});
  });
 });
 const timeout=setTimeout(()=>{
  try{child?.kill()}catch{}
  finish({ok:false,code:'timeout',message:'Время распознавания истекло. Повторите команду.'});
 },16000);
 return {promise,cancel(){
  try{child?.kill()}catch{}
  finish({ok:false,code:'cancelled',message:'Прослушивание остановлено.'});
 }};
}
module.exports={startNativeRecognition,startOfflineRecognition,offlinePaths};
