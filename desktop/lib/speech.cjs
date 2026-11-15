'use strict';
/* Windows built-in .NET System.Speech recognition.
   One-shot on explicit click, Russian language pack required. No cloud API key.
   No user text is ever injected into a PowerShell command. */
const {spawn}=require('node:child_process');
const SYSTEM_SPEECH_SCRIPT=`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Speech
  $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $russian = $installed | Where-Object { $_.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
  if ($null -eq $russian) {
    [Console]::WriteLine('{"ok":false,"code":"language","message":"Установите русский пакет распознавания речи Windows или введите команду текстом."}')
    exit 0
  }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($russian)
  try {
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
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
function startNativeRecognition({platform=process.platform,spawnProcess=spawn}={}){
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
module.exports={startNativeRecognition};
