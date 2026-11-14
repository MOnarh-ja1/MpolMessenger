// MPOL Windows launcher: self-contained UI + local reverse proxy to the server.
// Runs as a Windows GUI executable without a terminal window; opens Edge in app mode.
package main

import (
 "embed"
 "encoding/json"
 "errors"
 "fmt"
 "io/fs"
 "log"
 "net"
 "net/http"
 "net/http/httputil"
 "net/url"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "strings"
 "sync"
 "time"
)

//go:embed ui/*
var bundled embed.FS

type config struct{ URL string `json:"url"` }
var cfgMu sync.RWMutex
var cfg config
var lastSeenMu sync.Mutex
var lastSeen = time.Now()
var started = time.Now()
func touch(){lastSeenMu.Lock();lastSeen=time.Now();lastSeenMu.Unlock()}
func touchTime()time.Time{lastSeenMu.Lock();defer lastSeenMu.Unlock();return lastSeen}
func configFile()string{
 dir,err:=os.UserConfigDir();if err!=nil{dir="."}
 return filepath.Join(dir,"MpolMessenger","config.json")
}
func readConfig(){
 cfg=config{URL:"http://127.0.0.1:8000"}
 data,err:=os.ReadFile(configFile());if err==nil{var c config;if json.Unmarshal(data,&c)==nil {if validateTarget(c.URL)==nil {cfg=c}}}
}
func validateTarget(raw string)error{
 u,err:=url.Parse(strings.TrimSpace(raw));if err!=nil{return err}
 if u.Host==""||u.User!=nil||u.Path!=""&&u.Path!="/"||u.RawQuery!=""||u.Fragment!=""{return errors.New("укажите только адрес сервера, без пути")}
 if u.Scheme=="https"{return nil}
 host:=u.Hostname()
 if u.Scheme=="http"&&(host=="localhost"||host=="127.0.0.1"||host=="::1"){return nil}
 return errors.New("для удалённого сервера требуется HTTPS")
}
func saveConfig(w http.ResponseWriter,r *http.Request){
 if r.Method!="POST"{http.Error(w,"method not allowed",405);return}
 var in config
 if err:=json.NewDecoder(http.MaxBytesReader(w,r.Body,4096)).Decode(&in);err!=nil{http.Error(w,`{"error":"bad json"}`,400);return}
 in.URL=strings.TrimRight(strings.TrimSpace(in.URL),"/")
 if err:=validateTarget(in.URL);err!=nil{w.Header().Set("Content-Type","application/json");w.WriteHeader(400);_ =json.NewEncoder(w).Encode(map[string]string{"error":err.Error()});return}
 data,_:=json.MarshalIndent(in,"","  ")
 path:=configFile();_ =os.MkdirAll(filepath.Dir(path),0700)
 if err:=os.WriteFile(path,data,0600);err!=nil{http.Error(w,err.Error(),500);return}
 cfgMu.Lock();cfg=in;cfgMu.Unlock()
 w.Header().Set("Content-Type","application/json");_ =json.NewEncoder(w).Encode(map[string]bool{"ok":true})
}
func proxy(w http.ResponseWriter,r *http.Request){
 cfgMu.RLock();endpoint:=cfg.URL;cfgMu.RUnlock()
 target,err:=url.Parse(endpoint);if err!=nil{http.Error(w,"server configuration error",502);return}
 p:=httputil.NewSingleHostReverseProxy(target)
 origDirector:=p.Director
 p.Director=func(req *http.Request){origDirector(req);req.Host=target.Host}
 p.ErrorHandler=func(w http.ResponseWriter,r *http.Request,err error){
  w.Header().Set("Content-Type","application/json; charset=utf-8")
  w.WriteHeader(http.StatusBadGateway)
  _,_=w.Write([]byte(`{"detail":"Сервер недоступен. Запустите сервер или укажите его HTTPS-адрес."}`))
 }
 p.FlushInterval=50*time.Millisecond
 p.ServeHTTP(w,r)
}
func openApp(addr string)error{
 appUrl:="http://"+addr+"/"
 if runtime.GOOS=="windows"{
  paths:=[]string{}
  for _,base:=range []string{os.Getenv("ProgramFiles(x86)"),os.Getenv("ProgramFiles"),os.Getenv("LOCALAPPDATA")} {
   if base!=""{
    paths=append(paths,filepath.Join(base,"Microsoft","Edge","Application","msedge.exe"),filepath.Join(base,"Google","Chrome","Application","chrome.exe"))
   }
  }
  for _,p:=range paths{if _,err:=os.Stat(p);err==nil{
   return exec.Command(p,"--app="+appUrl,"--window-size=1250,820").Start()
  }}
  return exec.Command("rundll32.exe","url.dll,FileProtocolHandler",appUrl).Start()
 }
 for _,cmd:=range []string{"xdg-open","open"}{if path,err:=exec.LookPath(cmd);err==nil{return exec.Command(path,appUrl).Start()}}
 return errors.New("browser not found")
}
func main(){
 readConfig()
 site,err:=fs.Sub(bundled,"ui");if err!=nil{log.Fatal(err)}
 fileServer:=http.FileServer(http.FS(site))
 mux:=http.NewServeMux()
 mux.HandleFunc("/api/",proxy)
 mux.HandleFunc("/ws",proxy)
 mux.HandleFunc("/__ping",func(w http.ResponseWriter,r *http.Request){touch();w.Header().Set("X-Mpol-App","1");w.WriteHeader(204)})
 mux.HandleFunc("/__config",func(w http.ResponseWriter,r *http.Request){
   touch()
   // Only same-origin page may change the target; no CORS headers are provided.
   if r.Method=="POST"{
     origin:=r.Header.Get("Origin")
     if origin==""||origin!="http://"+r.Host{http.Error(w,"forbidden",403);return}
     saveConfig(w,r);return
   }
   cfgMu.RLock();c:=cfg;cfgMu.RUnlock()
   w.Header().Set("Content-Type","application/json");_ =json.NewEncoder(w).Encode(c)
 })
 mux.HandleFunc("/",func(w http.ResponseWriter,r *http.Request){
  touch()
  w.Header().Set("X-Content-Type-Options","nosniff")
  w.Header().Set("Referrer-Policy","no-referrer")
  w.Header().Set("Cache-Control","no-store")
  if r.URL.Path=="/"{
    data,readErr:=bundled.ReadFile("ui/index.html")
    if readErr!=nil{http.Error(w,"UI missing",500);return}
    w.Header().Set("Content-Type","text/html; charset=utf-8")
    _,_=w.Write(data)
    return
  }
  fileServer.ServeHTTP(w,r)
 })
 // A stable localhost port keeps authentication in the same browser origin after restart.
 ln,err:=net.Listen("tcp","127.0.0.1:44680")
 if err!=nil{
   checkClient:=&http.Client{Timeout:750*time.Millisecond}
   if resp,checkErr:=checkClient.Get("http://127.0.0.1:44680/__ping");checkErr==nil{
      recognized:=resp.Header.Get("X-Mpol-App")=="1"
      _=resp.Body.Close()
      if recognized{_ =openApp("127.0.0.1:44680");return}
   }
   // If another unrelated program owns this port, choose an isolated fallback.
   ln,err=net.Listen("tcp","127.0.0.1:0")
   if err!=nil{log.Fatal(err)}
 }
 address:=ln.Addr().String()
 server:=&http.Server{Handler:mux,ReadHeaderTimeout:10*time.Second,IdleTimeout:100*time.Second}
 go func(){if err:=server.Serve(ln);err!=nil&&err!=http.ErrServerClosed{log.Print(err)}}()
 if err:=openApp(address);err!=nil{fmt.Println("Open http://"+address);log.Print(err)}
 // Terminate the invisible launcher after the app window stops pinging.
 for time.Since(started)<30*time.Second || time.Since(touchTime())<75*time.Second{time.Sleep(5*time.Second)}
}
