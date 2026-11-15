"""Persistent MPOL communities, text channels, roles and small-group voice rooms.

Rooms use authenticated WSS signaling and a maximum of four WebRTC mesh peers.
Room occupancy is process-local; persistent servers/memberships/channels are
stored in PostgreSQL (Neon) or SQLite during local tests.
"""
from __future__ import annotations
import asyncio
import json
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Literal

from fastapi import Depends, HTTPException, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy import ForeignKey, String, Integer, Text, DateTime, UniqueConstraint, select, delete, func
from sqlalchemy.orm import Mapped, mapped_column

def make_space_models(Base):
    class Space(Base):
        __tablename__ = 'server_spaces'
        id: Mapped[str] = mapped_column(String(40), primary_key=True)
        owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
        name: Mapped[str] = mapped_column(String(72))
        description: Mapped[str] = mapped_column(String(260), default='')
        icon: Mapped[str] = mapped_column(String(10), default='◈')
        created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None))

    class SpaceMember(Base):
        __tablename__ = 'server_space_members'
        space_id: Mapped[str] = mapped_column(ForeignKey('server_spaces.id'), primary_key=True)
        user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
        role: Mapped[str] = mapped_column(String(14), default='member')

    class SpaceChannel(Base):
        __tablename__ = 'server_space_channels'
        id: Mapped[str] = mapped_column(String(40), primary_key=True)
        space_id: Mapped[str] = mapped_column(ForeignKey('server_spaces.id'), index=True)
        name: Mapped[str] = mapped_column(String(64))
        kind: Mapped[str] = mapped_column(String(10))
        chat_id: Mapped[str | None] = mapped_column(ForeignKey('chats.id'), nullable=True)
        position: Mapped[int] = mapped_column(Integer, default=0)

    class SpaceBan(Base):
        __tablename__ = 'server_space_bans'
        space_id: Mapped[str] = mapped_column(ForeignKey('server_spaces.id'), primary_key=True)
        user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)

    return Space, SpaceMember, SpaceChannel, SpaceBan

class NewServer(BaseModel):
    name: str = Field(min_length=2, max_length=72)
    description: str = Field(default='', max_length=260)
    icon: str = Field(default='◈', min_length=1, max_length=5)

class EditServer(BaseModel):
    name: str = Field(min_length=2,max_length=72)
    description: str = Field(default='',max_length=260)
    icon: str = Field(default='◈',min_length=1,max_length=5)

class InviteUser(BaseModel):
    user_id: str = Field(min_length=1,max_length=24)

class NewChannel(BaseModel):
    name: str = Field(min_length=2,max_length=64)
    kind: Literal['text','voice']

class ChangeRole(BaseModel):
    role: Literal['admin','moderator','member']

class VoiceRoomHub:
    """One voice room per WebSocket; prevent cross-server signaling."""
    def __init__(self, SessionLocal, SpaceMember, SpaceChannel, get_user, emit):
        self.SessionLocal=SessionLocal
        self.SpaceMember=SpaceMember
        self.SpaceChannel=SpaceChannel
        self.get_user=get_user
        self.emit=emit
        self.rooms=defaultdict(lambda: defaultdict(set))
        self.socket_room={}

    def authorized(self, uid, channel_id):
        with self.SessionLocal() as d:
            room=d.get(self.SpaceChannel,channel_id)
            return bool(room and room.kind=='voice' and d.get(self.SpaceMember,(room.space_id,uid)))

    def occupants(self, channel_id):
        return list(self.rooms.get(channel_id,{}))

    async def _send(self, channel_id, payload, exclude=None, user=None):
        group=self.rooms.get(channel_id,{})
        for uid,sockets in list(group.items()):
            if user is not None and uid!=user:continue
            for ws in list(sockets):
                if ws is exclude:continue
                try:await ws.send_json(payload)
                except Exception:await self.leave(ws)

    async def leave(self, ws, notify=True):
        current=self.socket_room.pop(ws,None)
        if not current:return
        room_id,uid=current
        room=self.rooms.get(room_id,{})
        connections=room.get(uid,set())
        connections.discard(ws)
        if not connections:
            room.pop(uid,None)
            if notify:
                await self._send(room_id,{'type':'space_voice_peer_left','channel_id':room_id,'user_id':uid})
        if not room:self.rooms.pop(room_id,None)

    async def join(self, ws, uid, channel_id):
        if not isinstance(channel_id,str) or len(channel_id)>40 or not self.authorized(uid,channel_id):
            await ws.send_json({'type':'space_voice_error','message':'Нет доступа к комнате'})
            return
        if self.socket_room.get(ws)==(channel_id,uid):return
        await self.leave(ws)
        peers=self.occupants(channel_id)
        if uid not in peers and len(peers)>=4:
            await ws.send_json({'type':'space_voice_error','message':'Комната заполнена (максимум 4 участника)'})
            return
        self.rooms[channel_id][uid].add(ws)
        self.socket_room[ws]=(channel_id,uid)
        with self.SessionLocal() as d:
            people=[self.get_user(d,x) for x in peers if x!=uid]
            sender=self.get_user(d,uid)
        await ws.send_json({'type':'space_voice_joined','channel_id':channel_id,'peers':people})
        await self._send(channel_id,{'type':'space_voice_peer_joined','channel_id':channel_id,
            'user':sender},exclude=ws)

    async def signal(self, ws, uid, event):
        current=self.socket_room.get(ws)
        if not current or current[1]!=uid:return
        channel_id,uid=current
        if not self.authorized(uid,channel_id):
            await self.leave(ws);return
        dest=event.get('to');kind=event.get('kind');payload=event.get('payload')
        if not isinstance(dest,str) or dest==uid or dest not in self.rooms[channel_id]:return
        if kind not in ('offer','answer','ice') or not isinstance(payload,dict):return
        try:
            if len(json.dumps(payload))>65000:return
        except (TypeError,ValueError):return
        await self._send(channel_id,{'type':'space_voice_signal','channel_id':channel_id,
            'user_id':uid,'kind':kind,'payload':payload},user=dest)

    async def kick(self, uid):
        for room_id,users in list(self.rooms.items()):
            for ws in list(users.get(uid,())):
                try:await ws.send_json({'type':'space_voice_error','message':'Вы удалены из голосовой комнаты'})
                except Exception:pass
                await self.leave(ws)

def install_space_routes(app, SessionLocal, Base, Space, SpaceMember, SpaceChannel,
                         SpaceBan, User, Chat, ChatMember, is_friend, blocked, moderation_state,
                         emit, user_json):
    voice=VoiceRoomHub(SessionLocal,SpaceMember,SpaceChannel,
        lambda d,uid:user_json(d.get(User,uid)) if d.get(User,uid) else {'id':uid,'nick':'Участник'},emit)

    def member(d,server_id,uid):
        if not d.get(Space,server_id):raise HTTPException(404,'Сервер не найден')
        membership=d.get(SpaceMember,(server_id,uid))
        if not membership:raise HTTPException(403,'Вы не участник этого сервера')
        return membership

    rank={'member':0,'moderator':1,'admin':2,'owner':3}
    def require(d,sid,uid,level='moderator'):
        m=member(d,sid,uid)
        if rank[m.role]<rank[level]:raise HTTPException(403,'Недостаточно прав на сервере')
        return m

    def list_channels(d,sid):
        return list(d.scalars(select(SpaceChannel).where(SpaceChannel.space_id==sid)
                 .order_by(SpaceChannel.position,SpaceChannel.name)).all())

    def all_user_ids(d,sid):
        return list(d.scalars(select(SpaceMember.user_id).where(SpaceMember.space_id==sid)).all())

    def server_json(d,s,uid):
        m=d.get(SpaceMember,(s.id,uid))
        return {'id':s.id,'name':s.name,'description':s.description,'icon':s.icon,
            'role':m.role if m else None,'owner_id':s.owner_id,
            'members_count':d.scalar(select(func.count()).select_from(SpaceMember)
                .where(SpaceMember.space_id==s.id)) or 0}

    def link_text_chat(d,sid,name,created_by):
        chat_id=str(uuid.uuid4())
        d.add(Chat(id=chat_id,name='#'+name,is_group=True,owner_id=created_by))
        d.flush()
        for m in d.scalars(select(SpaceMember).where(SpaceMember.space_id==sid)):
            d.add(ChatMember(chat_id=chat_id,user_id=m.user_id,
                role='owner' if m.user_id==created_by else 'member'))
        return chat_id

    @app.get('/api/servers')
    def servers(u=Depends(app.state.authed),d=Depends(app.state.db)):
        memberships=d.scalars(select(SpaceMember).where(SpaceMember.user_id==u.id)).all()
        return [server_json(d,s,u.id) for m in memberships if (s:=d.get(Space,m.space_id))]

    @app.post('/api/servers')
    async def create_server(body:NewServer,u=Depends(app.state.authed),d=Depends(app.state.db)):
        name=body.name.strip()
        if len(name)<2:raise HTTPException(400,'Укажите название сервера')
        if (d.scalar(select(func.count()).select_from(Space)
             .where(Space.owner_id==u.id)) or 0)>=12:
            raise HTTPException(429,'Можно создать не больше 12 серверов')
        sid=str(uuid.uuid4())
        s=Space(id=sid,owner_id=u.id,name=name,description=body.description.strip(),icon=body.icon)
        d.add(s);d.flush()
        d.add(SpaceMember(space_id=sid,user_id=u.id,role='owner'));d.flush()
        chat=link_text_chat(d,sid,'общий',u.id)
        d.add(SpaceChannel(id=str(uuid.uuid4()),space_id=sid,name='общий',kind='text',chat_id=chat,position=0))
        d.add(SpaceChannel(id=str(uuid.uuid4()),space_id=sid,name='Игровая',kind='voice',position=1))
        d.commit()
        return server_json(d,s,u.id)

    @app.get('/api/servers/{sid}')
    def server_details(sid:str,u=Depends(app.state.authed),d=Depends(app.state.db)):
        m=member(d,sid,u.id);s=d.get(Space,sid)
        info=server_json(d,s,u.id)
        info['channels']=[{'id':c.id,'name':c.name,'kind':c.kind,'chat_id':c.chat_id,
            'position':c.position,'online':voice.occupants(c.id) if c.kind=='voice' else []}
            for c in list_channels(d,sid)]
        info['members']=[{**user_json(x),'role':sm.role}
            for sm in d.scalars(select(SpaceMember).where(SpaceMember.space_id==sid))
            if (x:=d.get(User,sm.user_id))]
        return info

    @app.put('/api/servers/{sid}')
    async def edit_server(sid:str,body:EditServer,u=Depends(app.state.authed),d=Depends(app.state.db)):
        require(d,sid,u.id,'admin');s=d.get(Space,sid)
        s.name=body.name.strip();s.icon=body.icon;s.description=body.description.strip()
        d.commit();await emit(all_user_ids(d,sid),{'type':'servers_changed'})
        return server_json(d,s,u.id)

    @app.post('/api/servers/{sid}/members')
    async def add_server_member(sid:str,body:InviteUser,u=Depends(app.state.authed),d=Depends(app.state.db)):
        require(d,sid,u.id,'moderator')
        other=d.get(User,body.user_id)
        if not other or moderation_state(d,other.id):raise HTTPException(404,'Пользователь не найден')
        if not is_friend(d,u.id,other.id) or blocked(d,u.id,other.id):
            raise HTTPException(403,'Приглашать можно только своих друзей')
        if d.get(SpaceBan,(sid,other.id)):
            raise HTTPException(403,'Участник заблокирован на сервере')
        if d.get(SpaceMember,(sid,other.id)):
            return {'ok':True,'already_member':True}
        if len(all_user_ids(d,sid))>=100:raise HTTPException(400,'Максимум 100 участников')
        d.add(SpaceMember(space_id=sid,user_id=other.id,role='member'));d.flush()
        for c in list_channels(d,sid):
            if c.kind=='text' and c.chat_id:
                d.add(ChatMember(chat_id=c.chat_id,user_id=other.id,role='member'))
        d.commit()
        await emit(all_user_ids(d,sid),{'type':'servers_changed'})
        await emit([other.id],{'type':'chats_changed'})
        return {'ok':True}

    @app.patch('/api/servers/{sid}/members/{target}/role')
    async def change_role(sid:str,target:str,body:ChangeRole,
                          u=Depends(app.state.authed),d=Depends(app.state.db)):
        actor=require(d,sid,u.id,'admin')
        other=member(d,sid,target)
        if other.role=='owner' or target==u.id:raise HTTPException(403,'Нельзя менять эту роль')
        if actor.role!='owner' and (other.role=='admin' or body.role=='admin'):
            raise HTTPException(403,'Назначать администраторов может только владелец')
        other.role=body.role;d.commit()
        await emit(all_user_ids(d,sid),{'type':'servers_changed'})
        return {'ok':True}

    @app.delete('/api/servers/{sid}/members/{target}')
    async def remove_member(sid:str,target:str,ban:bool=False,
                            u=Depends(app.state.authed),d=Depends(app.state.db)):
        actor=member(d,sid,u.id)
        victim=member(d,sid,target)
        if victim.role=='owner':raise HTTPException(403,'Владелец не может покинуть сервер')
        if target!=u.id:
            if rank[actor.role]<rank['moderator'] or rank[actor.role]<=rank[victim.role]:
                raise HTTPException(403,'Недостаточно прав')
        if ban and target!=u.id and rank[actor.role]>=rank['moderator']:
            if not d.get(SpaceBan,(sid,target)):d.add(SpaceBan(space_id=sid,user_id=target))
        d.delete(victim)
        for c in list_channels(d,sid):
            if c.chat_id:
                m=d.scalar(select(ChatMember).where(ChatMember.chat_id==c.chat_id,
                    ChatMember.user_id==target))
                if m:d.delete(m)
        d.commit()
        await voice.kick(target)
        await emit(all_user_ids(d,sid)+[target],{'type':'servers_changed'})
        await emit([target],{'type':'chats_changed'})
        return {'ok':True}

    @app.post('/api/servers/{sid}/unban/{target}')
    async def unban_member(sid:str,target:str,u=Depends(app.state.authed),d=Depends(app.state.db)):
        require(d,sid,u.id,'admin')
        ban=d.get(SpaceBan,(sid,target))
        if ban:d.delete(ban);d.commit()
        return {'ok':True}

    @app.post('/api/servers/{sid}/channels')
    async def create_channel(sid:str,body:NewChannel,u=Depends(app.state.authed),d=Depends(app.state.db)):
        require(d,sid,u.id,'admin')
        name=body.name.strip().lstrip('#')
        if len(name)<2:raise HTTPException(400,'Название канала слишком короткое')
        if len(list_channels(d,sid))>=30:raise HTTPException(429,'Не больше 30 каналов')
        chat_id=link_text_chat(d,sid,name,u.id) if body.kind=='text' else None
        c=SpaceChannel(id=str(uuid.uuid4()),space_id=sid,name=name,kind=body.kind,
            chat_id=chat_id,position=len(list_channels(d,sid)))
        d.add(c);d.commit()
        await emit(all_user_ids(d,sid),{'type':'servers_changed'})
        return {'id':c.id,'chat_id':chat_id}

    @app.delete('/api/servers/{sid}/channels/{channel_id}')
    async def remove_channel(sid:str,channel_id:str,u=Depends(app.state.authed),d=Depends(app.state.db)):
        require(d,sid,u.id,'admin')
        c=d.get(SpaceChannel,channel_id)
        if not c or c.space_id!=sid:raise HTTPException(404,'Канал не найден')
        if c.kind=='text' and len([x for x in list_channels(d,sid) if x.kind=='text'])<2:
            raise HTTPException(400,'Оставьте минимум один текстовый канал')
        if c.chat_id:
            for m in d.scalars(select(ChatMember).where(ChatMember.chat_id==c.chat_id)).all():
                d.delete(m)
        d.delete(c);d.commit()
        await emit(all_user_ids(d,sid),{'type':'servers_changed'})
        return {'ok':True}

    return voice
