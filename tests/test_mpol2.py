"""MPOL 2 regression: existing accounts + favorites, archive, reactions,
profile photo, audio and authenticated WebRTC signaling (SQLite test DB only).
No production account is created or modified.
"""
import os
import sys
import tempfile
from pathlib import Path
from fastapi.testclient import TestClient

def run():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        root=Path(directory)
        os.environ['MPOL_DATABASE_URL']='sqlite:///'+str(root/'mpol2.db')
        os.environ['MPOL_UPLOAD_DIR']=str(root/'uploads')
        os.environ.pop('MPOL_REQUIRE_PERSISTENT_DB',None)
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
        from app import app,engine
        with TestClient(app) as client:
            def register(login):
                res=client.post('/api/auth/register',json={'nick':login.title(),
                    'login':login,'password':'local-test-password-123'})
                assert res.status_code==200,res.text
                x=res.json()
                return x['user']['id'],x['token'],{'Authorization':'Bearer '+x['token']}
            a,at,ah=register('mpol_two_alice')
            b,bt,bh=register('mpol_two_bob')
            assert client.get('/api/health').json()['ok']
            saved=client.post('/api/me/saved',headers=ah)
            assert saved.status_code==200,saved.text
            saved_id=saved.json()['id']
            assert saved_id=='SAVED_'+a
            assert client.post('/api/me/saved',headers=ah).json()['id']==saved_id
            r=client.post('/api/chats/'+saved_id+'/messages',headers=ah,json={'body':'Моя приватная заметка'})
            assert r.status_code==200,r.text
            assert client.get('/api/chats/'+saved_id+'/messages',headers=bh).status_code==403

            request=client.post('/api/friends/request',headers=ah,json={'target_id':b})
            assert request.status_code==200,request.text
            pending=client.get('/api/friends/requests',headers=bh).json()
            assert len(pending)==1
            accepted=client.post('/api/friends/requests/'+str(pending[0]['request_id']),
                                 headers=bh,json={'accept':True})
            assert accepted.status_code==200,accepted.text
            dm=client.post('/api/dm/'+b,headers=ah)
            assert dm.status_code==200,dm.text
            chat_id=dm.json()['id']
            posted=client.post('/api/chats/'+chat_id+'/messages',headers=ah,json={'body':'Привет, MPOL 2!'})
            assert posted.status_code==200,posted.text
            msg_id=posted.json()['id']
            reaction=client.put('/api/messages/'+msg_id+'/reaction',headers=bh,json={'emoji':'🔥'})
            assert reaction.status_code==200,reaction.text
            assert reaction.json()['reactions'][0]['count']==1
            assert reaction.json()['reactions'][0]['users']==[b]
            assert client.put('/api/messages/'+msg_id+'/reaction',headers=bh,json={'emoji':'🔥'}).json()['reactions']==[]
            assert client.put('/api/messages/'+msg_id+'/reaction',headers=bh,json={'emoji':'???'}).status_code==400

            assert client.put('/api/chats/'+chat_id+'/archive',headers=ah,json={'archived':True}).status_code==200
            archived=next(x for x in client.get('/api/chats',headers=ah).json() if x['id']==chat_id)
            assert archived['archived'] is True
            assert client.put('/api/chats/'+chat_id+'/archive',headers=ah,json={'archived':False}).status_code==200
            assert next(x for x in client.get('/api/chats',headers=ah).json() if x['id']==chat_id)['archived'] is False

            photo=b'\x89PNG\r\n\x1a\n'+b'mpol-avatar-sample'
            p=client.post('/api/me/photo',headers=ah,files={'file':('profile.png',photo,'image/png')})
            assert p.status_code==200,p.text
            assert p.json()['avatar']=='📷'
            assert client.get('/api/avatars/'+a).content==photo
            assert client.post('/api/me/photo',headers=ah,files={'file':('bad.png',b'abc','image/png')}).status_code==415

            voice=b'\x1a\x45\xdf\xa3'+b'voice-test-not-a-real-audio'
            upload=client.post('/api/chats/'+chat_id+'/attachments',headers=ah,
                files={'file':('voice-sample.webm',voice,'audio/webm')})
            assert upload.status_code==200,upload.text
            attach_id=upload.json()['id']
            assert upload.json()['type']=='audio/webm'
            sent=client.post('/api/chats/'+chat_id+'/messages',headers=ah,json={'attachment_id':attach_id})
            assert sent.status_code==200,sent.text
            assert sent.json()['attachment']['type']=='audio/webm'
            assert client.get('/api/attachments/'+attach_id,headers=bh).content==voice

            # The test confirms signaling between two independently authenticated sockets;
            # it does not claim a remote WebRTC audio/video connection was established.
            with client.websocket_connect('/ws') as recipient:
                recipient.send_json({'type':'auth','token':bt})
                assert recipient.receive_json()['type']=='authenticated'
                with client.websocket_connect('/ws') as origin:
                    origin.send_json({'type':'auth','token':at})
                    assert origin.receive_json()['type']=='authenticated'
                    assert recipient.receive_json()['type']=='presence'
                    callid='mpol-test-call-01'
                    origin.send_json({'type':'call_signal','to':b,'kind':'invite',
                        'call_id':callid,'payload':{'mode':'audio'}})
                    event=recipient.receive_json()
                    assert event['type']=='call_signal',event
                    assert event['call_id']==callid and event['from_id']==a
                    assert event['kind']=='invite'
                    recipient.send_json({'type':'call_signal','to':a,'kind':'decline',
                        'call_id':callid})
                    reply=origin.receive_json()
                    assert reply['type']=='call_signal' and reply['kind']=='decline'
            print('PASS: saved, archive, reactions, photo, audio, authorized two-user signaling')
        engine.dispose()

if __name__=='__main__':
    run()
