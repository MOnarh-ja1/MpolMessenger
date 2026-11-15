"""MPOL Servers regression: real REST/SQLite permission checks and room signaling."""
import os
import sys
import tempfile
from pathlib import Path

def run():
    with tempfile.TemporaryDirectory() as temp:
        os.environ['MPOL_DATABASE_URL']='sqlite:///'+str(Path(temp)/'servers.db')
        os.environ['MPOL_UPLOAD_DIR']=str(Path(temp)/'uploads')
        os.environ.pop('MPOL_REQUIRE_PERSISTENT_DB',None)
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
        from app import app
        from fastapi.testclient import TestClient
        with TestClient(app) as client:
            def register(name):
                response=client.post('/api/auth/register',json={
                    'nick':name,'login':name.lower(),
                    'password':'local-test-password-123'})
                assert response.status_code==200,response.text
                data=response.json()
                return data['user']['id'],data['token'],{'Authorization':'Bearer '+data['token']}

            a,at,ah=register('ServerAlice')
            b,bt,bh=register('ServerBob')
            c,ct,ch=register('ServerChris')
            assert client.get('/api/servers').status_code==401
            create=client.post('/api/servers',headers=ah,json={
                'name':'Игровая команда','description':'Тестовые комнаты','icon':'◈'})
            assert create.status_code==200,create.text
            sid=create.json()['id']
            detail=client.get('/api/servers/'+sid,headers=ah).json()
            assert detail['role']=='owner'
            assert {r['kind'] for r in detail['channels']}=={'text','voice'}
            voice=next(r['id'] for r in detail['channels'] if r['kind']=='voice')
            chat_id=next(r['chat_id'] for r in detail['channels'] if r['kind']=='text')
            assert client.get('/api/servers/'+sid,headers=bh).status_code==403
            assert client.post('/api/servers/'+sid+'/members',
                headers=ah,json={'user_id':b}).status_code==403

            # User B becomes a friend; only then may be added to the server.
            request=client.post('/api/friends/request',headers=ah,json={'target_id':b})
            assert request.status_code==200,request.text
            requests=client.get('/api/friends/requests',headers=bh).json()
            assert requests
            accept=client.post('/api/friends/requests/'+str(requests[0]['request_id']),
                headers=bh,json={'accept':True})
            assert accept.status_code==200,accept.text
            invited=client.post('/api/servers/'+sid+'/members',headers=ah,json={'user_id':b})
            assert invited.status_code==200,invited.text
            assert client.get('/api/servers/'+sid,headers=bh).status_code==200
            assert client.get('/api/chats/'+chat_id+'/messages',headers=bh).status_code==200
            # Outsiders do not get server text channels.
            assert client.get('/api/chats/'+chat_id+'/messages',headers=ch).status_code==403
            assert client.post('/api/servers/'+sid+'/channels',headers=bh,
                json={'name':'секретная','kind':'voice'}).status_code==403
            assert client.patch('/api/servers/'+sid+'/members/'+a+'/role',
                headers=bh,json={'role':'admin'}).status_code==403
            assert client.patch('/api/servers/'+sid+'/members/'+b+'/role',
                headers=ah,json={'role':'admin'}).status_code==200
            assert client.post('/api/servers/'+sid+'/channels',headers=bh,
                json={'name':'Игра 1','kind':'voice'}).status_code==200
            assert client.post('/api/servers/'+sid+'/channels',headers=bh,
                json={'name':'новости','kind':'text'}).status_code==200
            all_channels=client.get('/api/servers/'+sid,headers=bh).json()['channels']
            assert len(all_channels)==4

            # Voice presence and peer-specific signaling must use live membership.
            with client.websocket_connect('/ws') as wa:
                wa.send_json({'type':'auth','token':at})
                assert wa.receive_json()['type']=='authenticated'
                with client.websocket_connect('/ws') as wb:
                    wb.send_json({'type':'auth','token':bt})
                    assert wb.receive_json()['type']=='authenticated'
                    wa.send_json({'type':'space_voice_join','channel_id':voice})
                    joined_a=wa.receive_json()
                    assert joined_a['type']=='space_voice_joined'
                    assert joined_a['peers']==[]
                    wb.send_json({'type':'space_voice_join','channel_id':voice})
                    joined_b=wb.receive_json()
                    assert joined_b['type']=='space_voice_joined'
                    assert [x['id'] for x in joined_b['peers']]==[a]
                    peer_a=wa.receive_json()
                    assert peer_a['type']=='space_voice_peer_joined'
                    assert peer_a['user']['id']==b
                    wb.send_json({'type':'space_voice_signal','to':a,
                        'kind':'offer','payload':{'sdp':{'type':'offer','sdp':'unit-test'}}})
                    delivered=wa.receive_json()
                    assert delivered['type']=='space_voice_signal'
                    assert delivered['user_id']==b
                    wa.send_json({'type':'space_voice_leave'})
                    left=wb.receive_json()
                    assert left['type']=='space_voice_peer_left'

            # A can remove admin B; B must lose access to all server channels.
            kicked=client.delete('/api/servers/'+sid+'/members/'+b,headers=ah)
            assert kicked.status_code==200,kicked.text
            assert client.get('/api/servers/'+sid,headers=bh).status_code==403
            assert client.get('/api/chats/'+chat_id+'/messages',headers=bh).status_code==403
            assert client.get('/api/servers/'+sid,headers=ch).status_code==403
        print('PASS: server create, friends, roles, channels, WSS rooms, permission isolation')

if __name__=='__main__':
    run()
