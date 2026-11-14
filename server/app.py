"""Mpol Messenger API. FastAPI + SQLAlchemy + Argon2id + WebSockets.
Use SQLite for a local demo, PostgreSQL for a hosted deployment.
"""
from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import hmac
import smtplib
from email.message import EmailMessage
import os
import re
import secrets
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote
from typing import Any

from argon2 import PasswordHasher
from argon2.low_level import Type
from fastapi import Depends, FastAPI, Header, HTTPException, Request, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, LargeBinary, UniqueConstraint, create_engine, select, delete, update, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker, Session

ROOT = Path(__file__).parent
DATABASE_URL = os.getenv("MPOL_DATABASE_URL", f"sqlite:///{ROOT / 'mpol.db'}")
UPLOAD_DIR = Path(os.getenv("MPOL_UPLOAD_DIR", str(ROOT / 'uploads')))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
SQLITE = DATABASE_URL.startswith("sqlite")
if SQLITE and os.getenv('MPOL_REQUIRE_PERSISTENT_DB') == '1':
    raise RuntimeError('Online mode requires MPOL_DATABASE_URL pointing to PostgreSQL; refusing temporary SQLite storage.')
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if SQLITE else {}, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16, type=Type.ID)
app = FastAPI(title="MPOL Messenger API", docs_url=None if os.getenv("MPOL_DISABLE_DOCS") == "1" else "/docs")

class Base(DeclarativeBase): pass

def now(): return datetime.now(timezone.utc).replace(tzinfo=None)

class User(Base):
    __tablename__ = 'users'
    id: Mapped[str] = mapped_column(String(24), primary_key=True)
    login: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    nick: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(String(260), default='')
    email: Mapped[str | None] = mapped_column(String(254), unique=True, nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default='online')
    avatar: Mapped[str] = mapped_column(String(16), default='◉')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

class SessionToken(Base):
    __tablename__ = 'sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)

class Friendship(Base):
    __tablename__ = 'friendships'
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    to_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    state: Mapped[str] = mapped_column(String(12), default='pending')
    __table_args__ = (UniqueConstraint('from_id', 'to_id'),)

class Block(Base):
    __tablename__ = 'blocks'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    target_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    __table_args__ = (UniqueConstraint('actor_id', 'target_id'),)

class Chat(Base):
    __tablename__ = 'chats'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80), default='')
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

class Member(Base):
    __tablename__ = 'members'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey('chats.id'), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    role: Mapped[str] = mapped_column(String(12), default='member')
    read_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    __table_args__ = (UniqueConstraint('chat_id','user_id'),)

class Message(Base):
    __tablename__ = 'messages'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey('chats.id'), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    body: Mapped[str] = mapped_column(Text, default='')
    reply_to: Mapped[str | None] = mapped_column(ForeignKey('messages.id'), nullable=True)
    attachment_id: Mapped[str | None] = mapped_column(ForeignKey('attachments.id'), nullable=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)

class EmailToken(Base):
    __tablename__ = 'email_tokens'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), index=True)
    purpose: Mapped[str] = mapped_column(String(12))
    token_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)

class Attachment(Base):
    __tablename__ = 'attachments'
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey('chats.id'))
    owner_id: Mapped[str] = mapped_column(ForeignKey('users.id'))
    display_name: Mapped[str] = mapped_column(String(160))
    content_type: Mapped[str] = mapped_column(String(100))
    file_path: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(Integer)

class AttachmentBlob(Base):
    """Binary attachments in PostgreSQL, independent of Render ephemeral disk."""
    __tablename__ = 'attachment_blobs'
    attachment_id: Mapped[str] = mapped_column(ForeignKey('attachments.id'), primary_key=True)
    data: Mapped[bytes] = mapped_column(LargeBinary)


class ChatDismissal(Base):
    """Per-user chat deletion: old history stays hidden only for that user."""
    __tablename__ = 'chat_dismissals'
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey('chats.id'), primary_key=True)
    deleted_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    hidden: Mapped[bool] = mapped_column(Boolean, default=True)

class AccountModeration(Base):
    """Admin-only ban/deletion state, never determined by client-provided roles."""
    __tablename__ = 'account_moderation'
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    state: Mapped[str] = mapped_column(String(12))  # banned / deleted
    reason: Mapped[str] = mapped_column(String(300), default='')
    moderator_id: Mapped[str] = mapped_column(String(24))
    changed_at: Mapped[datetime] = mapped_column(DateTime, default=now)

class ChatArchive(Base):
    __tablename__ = 'chat_archives'
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    chat_id: Mapped[str] = mapped_column(ForeignKey('chats.id'), primary_key=True)

class MessageReaction(Base):
    __tablename__ = 'message_reactions'
    message_id: Mapped[str] = mapped_column(ForeignKey('messages.id'), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    emoji: Mapped[str] = mapped_column(String(16))

class ProfilePhoto(Base):
    __tablename__ = 'profile_photos'
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id'), primary_key=True)
    mime_type: Mapped[str] = mapped_column(String(30))
    data: Mapped[bytes] = mapped_column(LargeBinary)

Base.metadata.create_all(engine)

class Register(BaseModel):
    login: str = Field(min_length=3,max_length=32)
    nick: str = Field(min_length=1,max_length=48)
    password: str = Field(min_length=10,max_length=256)
    email: str | None = None
class Login(BaseModel):
    login: str
    password: str
class FriendRequest(BaseModel): target_id: str
class FriendRespond(BaseModel): accept: bool
class ArchiveChange(BaseModel): archived: bool
class ReactionChange(BaseModel): emoji: str = Field(min_length=1,max_length=12)
class NewChat(BaseModel): name: str = Field(min_length=2,max_length=80); members: list[str] = Field(default_factory=list, max_length=30)
class NewMessage(BaseModel):
    body: str = Field(default='',max_length=4000)
    reply_to: str | None = None
    attachment_id: str | None = None
class EditMessage(BaseModel): body: str = Field(min_length=1,max_length=4000)
class ProfileEdit(BaseModel):
    nick: str | None = Field(None,min_length=1,max_length=48)
    description: str | None = Field(None,max_length=260)
    status: str | None = None
    avatar: str | None = Field(None,max_length=8)
class PasswordChange(BaseModel): old_password: str; new_password: str = Field(min_length=10,max_length=256)
class MemberAdd(BaseModel): user_id: str
class EmailConfirm(BaseModel): code: str = Field(min_length=8,max_length=8)
class ModerationReason(BaseModel):
    reason: str = Field(min_length=3, max_length=300)

class ModerationDeletion(BaseModel):
    confirm_id: str

class ResetRequest(BaseModel): email: str
class ResetConfirm(BaseModel):
    email: str
    code: str = Field(min_length=8,max_length=8)
    new_password: str = Field(min_length=10,max_length=256)

# In-memory limits are suitable for a single process; use Redis/shared limiting for multiple workers.
limits: dict[str, deque] = defaultdict(deque)
def limit(key: str, count: int, window: int):
    q = limits[key]; t = time.monotonic()
    while q and q[0] < t-window: q.popleft()
    if len(q) >= count: raise HTTPException(429, 'Слишком много запросов. Повторите позже.')
    q.append(t)


def db():
    with SessionLocal() as d: yield d

def hash_token(t: str) -> str: return hashlib.sha256(t.encode()).hexdigest()
def issue_token(d: Session, user_id: str):
    token = secrets.token_urlsafe(36)
    d.add(SessionToken(token_hash=hash_token(token), user_id=user_id,expires_at=now()+timedelta(days=30)))
    d.commit()
    return token

def moderation_state(d: Session, user_id: str) -> str | None:
    record = d.get(AccountModeration, user_id)
    return record.state if record else None

def authed(authorization: str | None = Header(default=None), d: Session = Depends(db)) -> User:
    token = (authorization or '').removeprefix('Bearer ').strip()
    if not token: raise HTTPException(401,'Необходим вход')
    sess = d.get(SessionToken,hash_token(token))
    if sess is None or sess.expires_at < now(): raise HTTPException(401,'Сессия недействительна')
    user = d.get(User,sess.user_id)
    if not user or moderation_state(d, user.id):
        raise HTTPException(401,'Аккаунт заблокирован или удалён')
    return user

def is_developer(u: User) -> bool:
    # Exact, server-controlled allowlist. Never trust a role or ID sent by the client.
    allowed={x.strip().upper() for x in os.getenv('MPOL_DEVELOPER_IDS','').split(',') if x.strip()}
    return u.id.upper() in allowed

def developer_only(u:User=Depends(authed)) -> User:
    if not is_developer(u):raise HTTPException(403,'Нет прав разработчика')
    return u

def private_user_json(u: User):
    return {**user_json(u),"email":u.email,"email_verified":u.email_verified,
            "is_developer":is_developer(u)}


def user_json(u: User):
    return {'id':u.id,'nick':u.nick,'avatar':u.avatar,'description':u.description,
            'status':u.status, 'online':(u.id in sockets and bool(sockets[u.id]) and u.status!='invisible')}

def get_member(d: Session, chat_id: str, user_id: str) -> Member:
    m = d.scalar(select(Member).where(Member.chat_id==chat_id,Member.user_id==user_id))
    if not m: raise HTTPException(403,'Нет доступа к этому чату')
    return m

def is_friend(d:Session, x:str,y:str):
    return d.scalar(select(Friendship).where(Friendship.state=='accepted',
                  ((Friendship.from_id==x)&(Friendship.to_id==y)) | ((Friendship.from_id==y)&(Friendship.to_id==x)))) is not None

def blocked(d:Session, x:str,y:str):
    return d.scalar(select(Block).where(((Block.actor_id==x)&(Block.target_id==y))|((Block.actor_id==y)&(Block.target_id==x)))) is not None

def msg_json(d: Session, m: Message):
    sender = d.get(User,m.user_id)
    a = d.get(Attachment,m.attachment_id) if m.attachment_id else None
    return {'id':m.id,'chat_id':m.chat_id,'user_id':m.user_id,'nick':sender.nick if sender else 'Удалён',
            'avatar':sender.avatar if sender else '◉', 'body': '' if m.deleted else m.body,
            'reply_to':m.reply_to,'attachment':({'id':a.id,'name':a.display_name,'size':a.size,'type':a.content_type} if a and not m.deleted else None),
            'reactions':[{'emoji':e,'count':len(users),'users':users} for e,users in sorted(
                ((emoji, [r.user_id for r in rows if r.emoji==emoji]) for emoji in set(r.emoji for r in rows)),key=lambda x:-len(x[1]))] if (rows:=d.scalars(select(MessageReaction).where(MessageReaction.message_id==m.id)).all()) else [],
            'deleted':m.deleted,'sent_at':m.sent_at.isoformat()+'Z','edited_at':m.edited_at.isoformat()+'Z' if m.edited_at else None}

sockets: dict[str,set[WebSocket]] = defaultdict(set)
async def emit(ids: list[str] | set[str], payload: dict):
    for uid in set(ids):
        for ws in list(sockets.get(uid,())):
            try: await ws.send_json(payload)
            except Exception: sockets[uid].discard(ws)

def members_of(d: Session, cid: str):
    return list(d.scalars(select(Member.user_id).where(Member.chat_id==cid)).all())

@app.get('/api/health')
def health():
    is_temp = SQLITE and os.getenv('MPOL_EPHEMERAL_STORAGE') == '1'
    return {'ok':True,'version':'2.2.0','temporary_storage':is_temp,'durable_database':not SQLITE}

# WebRTC ICE: prefer a configured private TURN relay, otherwise use the
# publicly documented Metered Open Relay static-auth service (best effort).
# The free public relay has quota/availability limits; NEVER report it as proven
# reachable simply because credentials could be generated.
# Official info: https://www.metered.ca/tools/openrelay/
@app.get('/api/calls/ice')
def ice_configuration(u: User = Depends(authed)):
    limit('call-ice:' + u.id, 30, 60)
    servers = [{'urls': ['stun:stun.cloudflare.com:3478',
                         'stun:stun.l.google.com:19302']}]
    urls = [v.strip() for v in os.getenv('MPOL_TURN_URLS', '').split(',') if v.strip()]
    urls = [v for v in urls if re.fullmatch(r'turns?:[^\s]{3,240}', v)][:6]
    relay = False
    provider = 'stun-only'
    ttl = 0
    secret = os.getenv('MPOL_TURN_SECRET', '').strip()
    static_username = os.getenv('MPOL_TURN_USERNAME', '').strip()
    static_password = os.getenv('MPOL_TURN_PASSWORD', '').strip()
    if urls and secret:
        provider = 'custom-turn'
    elif urls and static_username and static_password:
        provider = 'custom-turn'
    elif os.getenv('MPOL_DISABLE_PUBLIC_TURN', '0') != '1':
        # Documented, public shared TURN REST auth credential; NOT private data.
        # No Metered account or VPS is needed, but public relays can reach their
        # shared 20GB/month quota, be unavailable, or change provider policy.
        urls = ['turn:staticauth.openrelay.metered.ca:80?transport=udp',
                'turn:staticauth.openrelay.metered.ca:443?transport=tcp',
                'turns:staticauth.openrelay.metered.ca:443?transport=tcp']
        secret = 'openrelayprojectsecret'
        provider = 'metered-openrelay-public'
    if urls and secret:
        try:
            ttl = min(86400, max(600, int(os.getenv('MPOL_TURN_TTL', '3600'))))
        except (TypeError, ValueError):
            ttl = 3600
        username = str(int(time.time()) + ttl) + ':' + u.id
        credential = base64.b64encode(hmac.new(
            secret.encode('utf-8'), username.encode('utf-8'), hashlib.sha1
        ).digest()).decode('ascii')
        servers.append({'urls': urls, 'username': username, 'credential': credential})
        relay = True
    elif urls and static_username and static_password:
        servers.append({'urls': urls, 'username': static_username,
                        'credential': static_password})
        relay = True
    return {'iceServers': servers, 'relayConfigured': relay, 'relayProvider': provider,
            'relayVerified': False, 'ttlSeconds': ttl}


@app.post('/api/auth/register')
def register(body: Register, request: Request, d:Session=Depends(db)):
    limit('register:'+request.client.host,5,3600)
    login=body.login.lower().strip()
    if not re.fullmatch(r'[a-z0-9_.-]{3,32}',login): raise HTTPException(400,'Логин: латинские буквы, цифры, . _ -')
    if d.scalar(select(User).where(User.login==login)): raise HTTPException(409,'Логин занят')
    email=body.email.strip().lower() if body.email else None
    if email and (len(email)>254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email)): raise HTTPException(400,'Неверный email')
    if email and d.scalar(select(User).where(User.email==email)): raise HTTPException(409,'Email уже используется')
    uid='MP'+secrets.token_hex(5).upper()
    if not body.nick.strip(): raise HTTPException(400,"Никнейм не может быть пустым")
    u=User(id=uid,login=login,nick=body.nick.strip(),password_hash=ph.hash(body.password),email=email)
    d.add(u);d.commit()
    return {'token':issue_token(d,uid),'user':private_user_json(u)}

@app.post('/api/auth/login')
def login(body:Login,request:Request,d:Session=Depends(db)):
    limit('login:'+request.client.host,15,600)
    u=d.scalar(select(User).where(User.login==body.login.strip().lower()))
    try:
        if not u: ph.verify(ph.hash('dummy-not-a-real-password'),body.password) # keep similar error
        else: ph.verify(u.password_hash,body.password)
    except Exception: raise HTTPException(401,'Неверный логин или пароль')
    if not u: raise HTTPException(401,'Неверный логин или пароль')
    if moderation_state(d,u.id): raise HTTPException(403,'Аккаунт заблокирован или удалён')
    if ph.check_needs_rehash(u.password_hash): u.password_hash=ph.hash(body.password); d.commit()
    return {'token':issue_token(d,u.id),'user':private_user_json(u)}

@app.post('/api/auth/logout')
def logout(authorization:str|None=Header(None),u:User=Depends(authed),d:Session=Depends(db)):
    token=(authorization or '').removeprefix('Bearer ').strip()
    d.execute(delete(SessionToken).where(SessionToken.token_hash==hash_token(token)));d.commit()
    return {'ok':True}

@app.get('/api/me')
def me(u:User=Depends(authed)): return private_user_json(u)

@app.get('/api/windows-update')
def windows_update():
    # A checksum is mandatory for EXE auto-update, populated after release.
    digest=os.getenv('MPOL_WINDOWS_EXE_SHA256','').strip().lower()
    if digest and not re.fullmatch(r'[0-9a-f]{64}',digest):digest=''
    # The release tag and matching SHA-256 are set together ONLY after GitHub
    # confirms that the corresponding Windows EXE exists.
    release=os.getenv('MPOL_WINDOWS_RELEASE_TAG','v2.2.0').strip()
    if not re.fullmatch(r'v\d+\.\d+\.\d+',release):
        release='v2.2.0'
    version=release[1:]
    return {'version':version,'required':True,
      'download_url':'https://github.com/MOnarh-ja1/MpolMessenger/releases/download/'+release+'/MpolMessenger.exe',
      'sha256':digest}

def moderation_target(d:Session, actor:User, target_id:str) -> User:
    target=d.get(User,target_id)
    if not target:raise HTTPException(404,'Аккаунт не найден')
    if target.id==actor.id or is_developer(target):
        raise HTTPException(403,'Модерация собственного аккаунта или разработчика запрещена')
    return target

async def disconnect_moderated_user(user_id:str,kind:str):
    for ws in list(sockets.get(user_id,())):
        try:
            await ws.send_json({'type':'account_moderated','kind':kind})
            await ws.close(code=1008)
        except Exception:pass
        sockets[user_id].discard(ws)

@app.get('/api/developer/users/{user_id}/status')
def moderation_status(user_id:str,u:User=Depends(developer_only),d:Session=Depends(db)):
    limit('admin-status:'+u.id,80,60)
    target=moderation_target(d,u,user_id)
    record=d.get(AccountModeration,target.id)
    return {'user_id':target.id,'state':record.state if record else 'active'}

@app.post('/api/developer/users/{user_id}/ban')
async def moderation_ban(user_id:str,body:ModerationReason,u:User=Depends(developer_only),d:Session=Depends(db)):
    limit('admin-ban:'+u.id,12,3600)
    target=moderation_target(d,u,user_id)
    old=d.get(AccountModeration,target.id)
    if old and old.state=='deleted':raise HTTPException(409,'Аккаунт уже удалён')
    if old:
        old.state='banned';old.reason=body.reason.strip();old.changed_at=now();old.moderator_id=u.id
    else:
        d.add(AccountModeration(user_id=target.id,state='banned',reason=body.reason.strip(),
                                moderator_id=u.id,changed_at=now()))
    d.execute(delete(SessionToken).where(SessionToken.user_id==target.id))
    d.commit()
    await disconnect_moderated_user(target.id,'banned')
    return {'ok':True,'state':'banned'}

@app.delete('/api/developer/users/{user_id}/ban')
async def moderation_unban(user_id:str,u:User=Depends(developer_only),d:Session=Depends(db)):
    limit('admin-ban:'+u.id,12,3600)
    target=moderation_target(d,u,user_id)
    old=d.get(AccountModeration,target.id)
    if old and old.state=='deleted':raise HTTPException(409,'Удалённый аккаунт восстановить нельзя')
    if old:d.delete(old);d.commit()
    return {'ok':True,'state':'active'}

@app.delete('/api/developer/users/{user_id}')
async def moderation_delete_account(user_id:str,body:ModerationDeletion,
                                    u:User=Depends(developer_only),d:Session=Depends(db)):
    """Irreversible account deactivation/PII erasure; preserve FK tombstone for other chats."""
    limit('admin-delete:'+u.id,5,3600)
    target=moderation_target(d,u,user_id)
    if body.confirm_id!=target.id:raise HTTPException(400,'Для подтверждения введите точный ID')
    old=d.get(AccountModeration,target.id)
    if old and old.state=='deleted':raise HTTPException(409,'Аккаунт уже удалён')
    # Anonymized tombstone prevents foreign key damage to other users' conversations.
    target.nick='Удалённый аккаунт'
    target.login='deleted_'+secrets.token_hex(15)
    target.email=None
    target.email_verified=False
    target.password_hash=ph.hash(secrets.token_urlsafe(32))
    target.avatar='◉'
    target.description=''
    target.status='invisible'
    d.execute(delete(SessionToken).where(SessionToken.user_id==target.id))
    d.execute(delete(EmailToken).where(EmailToken.user_id==target.id))
    d.execute(delete(Friendship).where((Friendship.from_id==target.id)|(Friendship.to_id==target.id)))
    d.execute(delete(Block).where((Block.actor_id==target.id)|(Block.target_id==target.id)))
    d.execute(delete(MessageReaction).where(MessageReaction.user_id==target.id))
    d.execute(delete(ChatArchive).where(ChatArchive.user_id==target.id))
    d.execute(delete(ChatDismissal).where(ChatDismissal.user_id==target.id))
    photo=d.get(ProfilePhoto,target.id)
    if photo:d.delete(photo)
    # Remove the deleted account's sent message content and attachment binaries.
    own_messages=list(d.scalars(select(Message).where(Message.user_id==target.id)).all())
    for msg in own_messages:
        msg.body='';msg.deleted=True
        msg.edited_at=now()
    all_attachments=list(d.scalars(select(Attachment).where(Attachment.owner_id==target.id)).all())
    for attachment in all_attachments:
        d.execute(update(Message).where(Message.attachment_id==attachment.id).values(attachment_id=None))
        blob=d.get(AttachmentBlob,attachment.id)
        if blob:d.delete(blob)
        if SQLITE and attachment.file_path:
            try:Path(attachment.file_path).unlink(missing_ok=True)
            except OSError:pass
        d.delete(attachment)
    # Reassign groups owned by the erased user; preserve other members' conversations.
    for c in d.scalars(select(Chat).where(Chat.owner_id==target.id,Chat.is_group==True)).all():
        remaining=d.scalar(select(Member).where(Member.chat_id==c.id,Member.user_id!=target.id))
        if remaining:
            c.owner_id=remaining.user_id
            remaining.role='owner'
    d.execute(delete(Member).where(Member.user_id==target.id,Member.chat_id.not_like('DM_%')))
    if old:
        old.state='deleted';old.reason='Аккаунт удалён';old.changed_at=now();old.moderator_id=u.id
    else:
        d.add(AccountModeration(user_id=target.id,state='deleted',reason='Аккаунт удалён',
                                moderator_id=u.id,changed_at=now()))
    d.commit()
    await disconnect_moderated_user(target.id,'deleted')
    return {'ok':True,'state':'deleted'}


@app.get('/api/developer/status')
def developer_status(u:User=Depends(developer_only)):
    # Deliberately no access to unrelated users' private records.
    return {'ok':True,'mode':'developer','id':u.id,'version':'2.1.0'}


@app.patch('/api/me')
async def update_me(body:ProfileEdit,u:User=Depends(authed),d:Session=Depends(db)):
    if body.nick is not None:
        if not body.nick.strip():raise HTTPException(400,"Никнейм не может быть пустым")
        u.nick=body.nick.strip()
    if body.description is not None:u.description=body.description
    if body.status is not None:
        if body.status not in ('online','away','dnd','invisible'):raise HTTPException(400,'Неверный статус')
        u.status=body.status
    if body.avatar is not None: u.avatar=body.avatar or '◉'
    d.commit()
    friends = [f.to_id if f.from_id==u.id else f.from_id for f in d.scalars(select(Friendship).where(Friendship.state=='accepted',((Friendship.from_id==u.id)|(Friendship.to_id==u.id)))).all()]
    await emit(friends,{'type':'profile','user':user_json(u)})
    return private_user_json(u)

@app.post('/api/me/password')
def change_password(body:PasswordChange,u:User=Depends(authed),d:Session=Depends(db)):
    try: ph.verify(u.password_hash,body.old_password)
    except Exception: raise HTTPException(400,'Текущий пароль неверен')
    u.password_hash=ph.hash(body.new_password)
    d.execute(delete(SessionToken).where(SessionToken.user_id==u.id))
    d.commit()
    return {'ok':True,'reauth':True}

# Email verification/password recovery require a configured SMTP relay.
MAIL_SECRET = os.environ.get('MPOL_RECOVERY_SECRET', secrets.token_urlsafe(48)).encode()
def mail_hash(uid: str, purpose: str, code: str) -> str:
    return hmac.new(MAIL_SECRET,(uid+':'+purpose+':'+code).encode(),hashlib.sha256).hexdigest()

def send_mail(to: str, subject: str, body: str):
    host=os.environ.get('MPOL_SMTP_HOST')
    from_addr=os.environ.get('MPOL_SMTP_FROM')
    if not host or not from_addr:raise HTTPException(503,'Восстановление недоступно: SMTP не настроен')
    port=int(os.environ.get('MPOL_SMTP_PORT','587'))
    msg=EmailMessage()
    msg['From']=from_addr;msg['To']=to;msg['Subject']=subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(host,port,timeout=12) as smtp:
            smtp.starttls()
            username=os.environ.get('MPOL_SMTP_USER','')
            if username:smtp.login(username,os.environ.get('MPOL_SMTP_PASSWORD',''))
            smtp.send_message(msg)
    except Exception:
        raise HTTPException(503,'Не удалось отправить письмо. Проверьте настройки SMTP')

def issue_mail_code(d:Session,u:User,purpose:str):
    code=f'{secrets.randbelow(100_000_000):08d}'
    d.execute(delete(EmailToken).where(EmailToken.user_id==u.id,EmailToken.purpose==purpose))
    d.add(EmailToken(user_id=u.id,purpose=purpose,token_hash=mail_hash(u.id,purpose,code),expires_at=now()+timedelta(minutes=15)))
    d.commit()
    send_mail(u.email,'MPOL Messenger — код подтверждения',f'Ваш код MPOL: {code}\n\nКод действует 15 минут. Если вы не запрашивали код, игнорируйте письмо.')

def use_mail_code(d:Session,u:User,purpose:str,code:str):
    token=d.scalar(select(EmailToken).where(EmailToken.user_id==u.id,EmailToken.purpose==purpose))
    if not token or token.expires_at<now() or not hmac.compare_digest(token.token_hash,mail_hash(u.id,purpose,code)):
        raise HTTPException(400,'Неверный или устаревший код')
    d.delete(token)

@app.post('/api/auth/email/verification/request')
def email_verification_request(u:User=Depends(authed),d:Session=Depends(db)):
    limit('verify:'+u.id,3,3600)
    if not u.email:raise HTTPException(400,'Email не указан при регистрации')
    if u.email_verified:return {'ok':True}
    issue_mail_code(d,u,'verify')
    return {'ok':True}

@app.post('/api/auth/email/verification/confirm')
def email_verification_confirm(body:EmailConfirm,u:User=Depends(authed),d:Session=Depends(db)):
    limit('verify-codes:'+u.id,8,3600)
    use_mail_code(d,u,'verify',body.code)
    u.email_verified=True;d.commit()
    return {'ok':True}

@app.post('/api/auth/password/reset/request')
def reset_request(body:ResetRequest,request:Request,d:Session=Depends(db)):
    limit('reset:'+request.client.host,5,3600)
    user=d.scalar(select(User).where(User.email==body.email.lower().strip(),User.email_verified==True))
    if user:
        issue_mail_code(d,user,'reset')
    return {'ok':True,'message':'Если подтверждённый адрес существует, отправлен код.'}

@app.post('/api/auth/password/reset/confirm')
def reset_confirm(body:ResetConfirm,request:Request,d:Session=Depends(db)):
    limit('reset-code:'+request.client.host,10,3600)
    user=d.scalar(select(User).where(User.email==body.email.lower().strip(),User.email_verified==True))
    if not user:raise HTTPException(400,'Неверный или устаревший код')
    use_mail_code(d,user,'reset',body.code)
    user.password_hash=ph.hash(body.new_password)
    d.execute(delete(SessionToken).where(SessionToken.user_id==user.id));d.commit()
    return {'ok':True}

@app.get('/api/users/{user_id}')
def profile(user_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    x=d.get(User,user_id)
    if not x or moderation_state(d,x.id)=='deleted': raise HTTPException(404,'Пользователь не найден')
    return user_json(x)

@app.get('/api/friends')
def friends(u:User=Depends(authed),d:Session=Depends(db)):
    fs=d.scalars(select(Friendship).where(Friendship.state=='accepted',((Friendship.from_id==u.id)|(Friendship.to_id==u.id)))).all()
    return [user_json(d.get(User,f.to_id if f.from_id==u.id else f.from_id)) for f in fs]

@app.get('/api/friends/requests')
def friend_requests(u:User=Depends(authed),d:Session=Depends(db)):
    fs=d.scalars(select(Friendship).where(Friendship.to_id==u.id,Friendship.state=='pending')).all()
    return [{'request_id':f.id,'user':user_json(d.get(User,f.from_id))} for f in fs]

@app.post('/api/friends/request')
async def request_friend(body:FriendRequest,u:User=Depends(authed),d:Session=Depends(db)):
    limit('friend:'+u.id,20,3600)
    x=d.get(User,body.target_id)
    if not x or x.id==u.id or moderation_state(d,x.id):raise HTTPException(404,'Пользователь не найден')
    if blocked(d,u.id,x.id):raise HTTPException(403,'Запрос недоступен')
    old=d.scalar(select(Friendship).where(((Friendship.from_id==u.id)&(Friendship.to_id==x.id)) | ((Friendship.from_id==x.id)&(Friendship.to_id==u.id))))
    if old:
        if old.state=='accepted':return {'ok':True,'state':'accepted'}
        if old.from_id==x.id and old.to_id==u.id and old.state=='pending':
            old.state='accepted';d.commit();await emit([x.id,u.id],{'type':'friends_changed'});return {'ok':True,'state':'accepted'}
        raise HTTPException(409,'Заявка уже существует')
    new_request=Friendship(from_id=u.id,to_id=x.id,state='pending')
    d.add(new_request);d.commit()
    # Deliver a targeted event to the recipient. The client also polls as a fallback.
    await emit([x.id],{'type':'friend_request','request_id':new_request.id,'user':user_json(u)})
    return {'ok':True,'state':'pending'}

@app.post('/api/friends/requests/{request_id}')
async def answer_request(request_id:int,body:FriendRespond,u:User=Depends(authed),d:Session=Depends(db)):
    f=d.get(Friendship,request_id)
    if not f or f.to_id!=u.id or f.state!='pending':raise HTTPException(404,'Заявка не найдена')
    if body.accept:f.state='accepted'
    else:d.delete(f)
    d.commit();await emit([u.id,f.from_id],{'type':'friends_changed'})
    return {'ok':True}

@app.post('/api/users/{user_id}/block')
async def block_user(user_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    if not d.get(User,user_id) or user_id==u.id or moderation_state(d,user_id)=='deleted':raise HTTPException(404,'Пользователь не найден')
    if not d.scalar(select(Block).where(Block.actor_id==u.id,Block.target_id==user_id)):
        d.add(Block(actor_id=u.id,target_id=user_id))
    for f in d.scalars(select(Friendship).where(((Friendship.from_id==u.id)&(Friendship.to_id==user_id))|((Friendship.from_id==user_id)&(Friendship.to_id==u.id)))).all():d.delete(f)
    d.commit();await emit([u.id,user_id],{'type':'friends_changed'})
    return {'ok':True}

@app.post('/api/dm/{user_id}')
def open_dm(user_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    if not is_friend(d,u.id,user_id) or blocked(d,u.id,user_id) or moderation_state(d,user_id):
        raise HTTPException(403,'Переписка недоступна')
    a,b=sorted([u.id,user_id]);cid='DM_'+a+'_'+b
    c=d.get(Chat,cid)
    if not c:
        c=Chat(id=cid,is_group=False,owner_id=u.id)
        d.add(c);d.flush()
        d.add_all([Member(chat_id=cid,user_id=a),Member(chat_id=cid,user_id=b)])
        d.commit()
    dismissal=d.get(ChatDismissal,(u.id,cid))
    if dismissal:
        dismissal.hidden=False
        d.commit()
    return {'id':cid}

@app.post('/api/groups')
async def create_group(body:NewChat,u:User=Depends(authed),d:Session=Depends(db)):
    participants={u.id}
    for user_id in body.members:
        if not is_friend(d,u.id,user_id) or blocked(d,u.id,user_id):raise HTTPException(403,f'Участник {user_id} не в друзьях')
        participants.add(user_id)
    cid=str(uuid.uuid4())
    d.add(Chat(id=cid,name=body.name.strip(),is_group=True,owner_id=u.id));d.flush()
    for user_id in participants:d.add(Member(chat_id=cid,user_id=user_id,role='owner' if user_id==u.id else 'member'))
    d.commit();await emit(participants,{'type':'chats_changed'})
    return {'id':cid}

@app.post('/api/groups/{chat_id}/members')
async def add_group_member(chat_id:str,body:MemberAdd,u:User=Depends(authed),d:Session=Depends(db)):
    m=get_member(d,chat_id,u.id);c=d.get(Chat,chat_id)
    if not c.is_group or m.role not in ('owner','admin'):raise HTTPException(403,'Недостаточно прав')
    if not is_friend(d,u.id,body.user_id) or blocked(d,u.id,body.user_id):raise HTTPException(403,'Участник должен быть вашим другом')
    if not d.scalar(select(Member).where(Member.chat_id==chat_id,Member.user_id==body.user_id)):
        d.add(Member(chat_id=chat_id,user_id=body.user_id));d.commit()
    await emit(members_of(d,chat_id),{'type':'chats_changed'})
    return {'ok':True}

@app.delete('/api/groups/{chat_id}/members/{user_id}')
async def remove_group_member(chat_id:str,user_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    me=get_member(d,chat_id,u.id);c=d.get(Chat,chat_id)
    if not c.is_group:raise HTTPException(400,'Не группа')
    if user_id!=u.id and me.role not in ('owner','admin'):raise HTTPException(403,'Недостаточно прав')
    target=get_member(d,chat_id,user_id)
    if target.role=='owner':raise HTTPException(403,'Владелец не может выйти до передачи прав')
    if target.role=='admin' and me.role!='owner' and user_id!=u.id:raise HTTPException(403,'Только владелец может удалить администратора')
    d.delete(target);d.commit()
    await emit(members_of(d,chat_id)+[user_id],{'type':'chats_changed'})
    return {'ok':True}

@app.post('/api/groups/{chat_id}/admins/{user_id}')
async def promote_admin(chat_id:str,user_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    me=get_member(d,chat_id,u.id)
    if me.role!='owner' or not d.get(Chat,chat_id).is_group:raise HTTPException(403,'Только владелец группы')
    target=get_member(d,chat_id,user_id);target.role='admin';d.commit()
    return {'ok':True}

@app.post('/api/me/saved')
def saved_chat(u:User=Depends(authed),d:Session=Depends(db)):
    """Create a private, account-specific notes chat; repeat calls are idempotent."""
    cid='SAVED_'+u.id
    c=d.get(Chat,cid)
    if not c:
        d.add(Chat(id=cid,name='Избранное',is_group=True,owner_id=u.id))
        d.flush()
        d.add(Member(chat_id=cid,user_id=u.id,role='owner'))
        d.commit()
    return {'id':cid}

@app.delete('/api/chats/{chat_id}')
async def remove_chat_from_my_list(chat_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    """Delete chat/history only for this account, never for another participant."""
    get_member(d,chat_id,u.id)
    if chat_id=='SAVED_'+u.id:
        raise HTTPException(400,'Избранное удалить нельзя')
    limit('delete-chat:'+u.id,30,3600)
    record=d.get(ChatDismissal,(u.id,chat_id))
    if record:
        record.deleted_at=now()
        record.hidden=True
    else:
        d.add(ChatDismissal(user_id=u.id,chat_id=chat_id,deleted_at=now(),hidden=True))
    archive=d.get(ChatArchive,(u.id,chat_id))
    if archive:d.delete(archive)
    d.commit()
    return {'ok':True,'deleted_for_me':True}


@app.put('/api/chats/{chat_id}/archive')
async def set_archive(chat_id:str,body:ArchiveChange,u:User=Depends(authed),d:Session=Depends(db)):
    get_member(d,chat_id,u.id)
    if chat_id=='SAVED_'+u.id:raise HTTPException(400,'Избранное нельзя архивировать')
    a=d.get(ChatArchive,(u.id,chat_id))
    if body.archived and not a:d.add(ChatArchive(user_id=u.id,chat_id=chat_id))
    if not body.archived and a:d.delete(a)
    d.commit()
    return {'ok':True,'archived':body.archived}

REACTION_CHOICES={'👍','❤️','😂','🔥','🎉','😮','😢','👏','👀','💯','😎','🙏'}
@app.put('/api/messages/{message_id}/reaction')
async def toggle_reaction(message_id:str,body:ReactionChange,u:User=Depends(authed),d:Session=Depends(db)):
    m=d.get(Message,message_id)
    if not m or m.deleted:raise HTTPException(404,'Сообщение не найдено')
    get_member(d,m.chat_id,u.id)
    if body.emoji not in REACTION_CHOICES:raise HTTPException(400,'Неизвестная реакция')
    r=d.get(MessageReaction,(message_id,u.id))
    if r and r.emoji==body.emoji:d.delete(r)
    elif r:r.emoji=body.emoji
    else:d.add(MessageReaction(message_id=message_id,user_id=u.id,emoji=body.emoji))
    d.commit()
    updated=msg_json(d,m)
    await emit(members_of(d,m.chat_id),{'type':'message_updated','message':updated})
    return updated

@app.post('/api/me/photo')
async def upload_profile_photo(file:UploadFile=File(...),u:User=Depends(authed),d:Session=Depends(db)):
    limit('avatar:'+u.id,12,3600)
    content=await file.read(800_001)
    mime=(file.content_type or '').lower()
    allowed={'image/png':content.startswith(b'\x89PNG\r\n\x1a\n'),
             'image/jpeg':content.startswith(b'\xff\xd8\xff'),
             'image/webp':content.startswith(b'RIFF') and content[8:12]==b'WEBP'}
    if mime not in allowed or not allowed[mime] or not content or len(content)>800_000:
        raise HTTPException(415,'Используйте PNG/JPG/WEBP не более 800 КБ')
    photo=d.get(ProfilePhoto,u.id)
    if photo:photo.data=content;photo.mime_type=mime
    else:d.add(ProfilePhoto(user_id=u.id,data=content,mime_type=mime))
    u.avatar='📷'
    d.commit()
    friends=[f.to_id if f.from_id==u.id else f.from_id for f in d.scalars(select(Friendship).where(Friendship.state=='accepted',((Friendship.from_id==u.id)|(Friendship.to_id==u.id)))).all()]
    await emit(friends,{'type':'profile','user':user_json(u)})
    return private_user_json(u)

@app.get('/api/avatars/{user_id}')
def profile_photo(user_id:str,d:Session=Depends(db)):
    record=d.get(ProfilePhoto,user_id)
    if not record:raise HTTPException(404,'Аватар не найден')
    return Response(content=record.data,media_type=record.mime_type,headers={
        'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})

@app.get('/api/chats')
def chats(u:User=Depends(authed),d:Session=Depends(db)):
    memberships=d.scalars(select(Member).where(Member.user_id==u.id)).all()
    result=[]
    for m in memberships:
        c=d.get(Chat,m.chat_id)
        if not c: continue
        dismissed=d.get(ChatDismissal,(u.id,c.id))
        visible_since=dismissed.deleted_at if dismissed else None
        msg_query=select(Message).where(Message.chat_id==c.id,Message.deleted==False)
        if visible_since:msg_query=msg_query.where(Message.sent_at>visible_since)
        ms=d.scalar(msg_query.order_by(Message.sent_at.desc()).limit(1))
        if dismissed and dismissed.hidden and not ms:continue
        users=list(d.scalars(select(Member.user_id).where(Member.chat_id==c.id)).all())
        peer = d.get(User,next((v for v in users if v!=u.id),u.id)) if not c.is_group else None
        unread_after=max(m.read_at,visible_since) if visible_since else m.read_at
        unread=d.scalar(select(func.count(Message.id)).where(Message.chat_id==c.id,Message.user_id!=u.id,Message.sent_at>unread_after)) or 0
        result.append({'id':c.id,'name':c.name if c.is_group else (peer.nick if peer else 'Диалог'),
                'avatar':'♣' if c.is_group else (peer.avatar if peer else '◉'),
                'is_group':c.is_group,'peer_id':peer.id if peer else None,
                'online':bool(peer and peer.id in sockets and sockets[peer.id] and peer.status!='invisible'),
                'members':users,'read_states':{v.user_id:v.read_at.isoformat()+'Z' for v in d.scalars(select(Member).where(Member.chat_id==c.id)).all()},'role':m.role,'unread':unread,
                'last':msg_json(d,ms) if ms else None,
                'is_saved':c.id=='SAVED_'+u.id,'archived':d.get(ChatArchive,(u.id,c.id)) is not None})
    return sorted(result,key=lambda x:(x['last']['sent_at'] if x['last'] else ''),reverse=True)

@app.get('/api/chats/{chat_id}/messages')
def messages(chat_id:str,before:str|None=None,search:str|None=None,u:User=Depends(authed),d:Session=Depends(db)):
    get_member(d,chat_id,u.id)
    q=select(Message).where(Message.chat_id==chat_id,Message.deleted==False)
    dismissed=d.get(ChatDismissal,(u.id,chat_id))
    if dismissed:q=q.where(Message.sent_at>dismissed.deleted_at)
    if before:
        try: at=datetime.fromisoformat(before.replace('Z','+00:00')).replace(tzinfo=None)
        except ValueError:raise HTTPException(400,'Неверная дата')
        q=q.where(Message.sent_at<at)
    if search:q=q.where(Message.body.ilike('%'+search[:100].replace('%','\\%').replace('_','\\_')+'%',escape='\\'))
    arr=list(d.scalars(q.order_by(Message.sent_at.desc()).limit(100)).all())
    return [msg_json(d,m) for m in reversed(arr)]

@app.post('/api/chats/{chat_id}/messages')
async def send_message(chat_id:str,body:NewMessage,u:User=Depends(authed),d:Session=Depends(db)):
    get_member(d,chat_id,u.id)
    limit('msg:'+u.id,40,60)
    c=d.get(Chat,chat_id)
    if not c.is_group:
        peer=next((x for x in members_of(d,chat_id) if x!=u.id),None)
        if peer and (blocked(d,u.id,peer) or moderation_state(d,peer)):
            raise HTTPException(403,'Сообщения недоступны')
    if not body.body.strip() and not body.attachment_id:raise HTTPException(400,'Пустое сообщение')
    if body.reply_to:
        reply=d.get(Message,body.reply_to)
        if not reply or reply.chat_id!=chat_id:raise HTTPException(400,'Неверное сообщение для ответа')
    if body.attachment_id:
        attachment=d.get(Attachment,body.attachment_id)
        if not attachment or attachment.chat_id!=chat_id or attachment.owner_id!=u.id:
            raise HTTPException(403,'Вложение недоступно')
    m=Message(id=str(uuid.uuid4()),chat_id=chat_id,user_id=u.id,body=body.body.strip(),reply_to=body.reply_to,attachment_id=body.attachment_id)
    d.add(m);d.commit()
    payload=msg_json(d,m)
    await emit(members_of(d,chat_id),{'type':'message','message':payload})
    return payload

@app.patch('/api/messages/{message_id}')
async def edit_message(message_id:str,body:EditMessage,u:User=Depends(authed),d:Session=Depends(db)):
    m=d.get(Message,message_id)
    if not m:raise HTTPException(404,'Сообщение не найдено')
    get_member(d,m.chat_id,u.id)
    if m.user_id!=u.id or m.deleted:raise HTTPException(403,'Можно редактировать только свои сообщения')
    m.body=body.body;m.edited_at=now();d.commit()
    await emit(members_of(d,m.chat_id),{'type':'message_updated','message':msg_json(d,m)})
    return msg_json(d,m)

@app.delete('/api/messages/{message_id}')
async def delete_message(message_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    m=d.get(Message,message_id)
    if not m:raise HTTPException(404,'Сообщение не найдено')
    get_member(d,m.chat_id,u.id)
    if m.user_id!=u.id:raise HTTPException(403,'Можно удалять только свои сообщения')
    chat_id=m.chat_id
    attachment_id=m.attachment_id
    # References must be cleared before physical deletion (PostgreSQL FK).
    d.execute(update(Message).where(Message.reply_to==message_id).values(reply_to=None))
    d.execute(delete(MessageReaction).where(MessageReaction.message_id==message_id))
    d.delete(m)
    d.flush()
    if attachment_id and not d.scalar(select(Message.id).where(Message.attachment_id==attachment_id).limit(1)):
        att=d.get(Attachment,attachment_id)
        if att:
            blob=d.get(AttachmentBlob,attachment_id)
            if blob:d.delete(blob);d.flush()
            if SQLITE and att.file_path:
                try:Path(att.file_path).unlink(missing_ok=True)
                except OSError:pass
            d.delete(att)
    d.commit()
    await emit(members_of(d,chat_id),{'type':'message_deleted','message_id':message_id,'chat_id':chat_id})
    return {'ok':True,'deleted':True}

@app.post('/api/chats/{chat_id}/read')
async def read_chat(chat_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    m=get_member(d,chat_id,u.id);m.read_at=now();d.commit()
    await emit(members_of(d,chat_id),{'type':'read','chat_id':chat_id,'user_id':u.id,'at':m.read_at.isoformat()+'Z'})
    return {'ok':True}

# Uploads: limit size, whitelist extension AND inspect signature for images; do not execute/unpack or serve as HTML.
ALLOWED={'.webm':'audio/webm','.ogg':'audio/ogg','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
         '.pdf':'application/pdf','.txt':'text/plain','.csv':'text/csv','.zip':'application/zip'}
def valid_magic(ext:str,data:bytes)->bool:
    if ext=='.webm':return data.startswith(b'\x1a\x45\xdf\xa3')
    if ext=='.ogg':return data.startswith(b'OggS')
    if ext=='.png':return data.startswith(b'\x89PNG\r\n\x1a\n')
    if ext in ('.jpg','.jpeg'):return data.startswith(b'\xff\xd8\xff')
    if ext=='.gif':return data.startswith((b'GIF87a',b'GIF89a'))
    if ext=='.webp':return data.startswith(b'RIFF') and data[8:12]==b'WEBP'
    if ext=='.pdf':return data.startswith(b'%PDF-')
    if ext=='.zip':return data.startswith(b'PK\x03\x04')
    return True

@app.post('/api/chats/{chat_id}/attachments')
async def upload(chat_id:str,file:UploadFile=File(...),u:User=Depends(authed),d:Session=Depends(db)):
    get_member(d,chat_id,u.id);limit('upload:'+u.id,20,3600)
    name=Path((file.filename or 'file').replace('\\','/')).name[:160]
    ext=Path(name).suffix.lower()
    if ext not in ALLOWED:raise HTTPException(415,'Разрешены WEBM, OGG, PNG, JPG, GIF, WEBP, PDF, TXT, CSV, ZIP')
    data=await file.read(12*1024*1024+1)
    if not data or len(data)>12*1024*1024:raise HTTPException(413,'Файл должен быть от 1 байта до 12 МБ')
    if not valid_magic(ext,data):raise HTTPException(415,'Содержимое файла не соответствует формату')
    fid=str(uuid.uuid4())
    a=Attachment(id=fid,chat_id=chat_id,owner_id=u.id,display_name=name,content_type=ALLOWED[ext],file_path='',size=len(data))
    d.add(a)
    if SQLITE:
        path=UPLOAD_DIR/(fid+ext)
        path.write_bytes(data)
        a.file_path=str(path)
    else:
        d.add(AttachmentBlob(attachment_id=fid,data=data))
    d.commit()
    return {'id':fid,'name':name,'size':len(data),'type':ALLOWED[ext]}

@app.get('/api/attachments/{attachment_id}')
def download(attachment_id:str,u:User=Depends(authed),d:Session=Depends(db)):
    a=d.get(Attachment,attachment_id)
    if not a:raise HTTPException(404,'Файл не найден')
    get_member(d,a.chat_id,u.id)
    blob=d.get(AttachmentBlob,attachment_id) if not SQLITE else None
    if blob:
        filename=quote(a.display_name,safe='')
        return Response(content=blob.data,media_type='application/octet-stream',headers={
            'Content-Disposition':"attachment; filename*=UTF-8''"+filename,
            'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'})
    path=Path(a.file_path)
    if not path.is_file():raise HTTPException(404,'Файл на сервере отсутствует')
    return FileResponse(path,media_type='application/octet-stream',filename=a.display_name,
            headers={'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'})

@app.websocket('/ws')
async def websocket(ws:WebSocket):
    await ws.accept()
    uid=None
    try:
        auth=await asyncio.wait_for(ws.receive_json(),timeout=8)
        if not isinstance(auth,dict) or auth.get('type')!='auth' or not isinstance(auth.get('token'),str):
            await ws.close(code=1008);return
        with SessionLocal() as d:
            sess=d.get(SessionToken,hash_token(auth['token']))
            if not sess or sess.expires_at<now() or moderation_state(d,sess.user_id):
                await ws.close(code=1008);return
            uid=sess.user_id
            friends=[f.to_id if f.from_id==uid else f.from_id for f in d.scalars(select(Friendship).where(Friendship.state=='accepted',((Friendship.from_id==uid)|(Friendship.to_id==uid)))).all()]
            user=d.get(User,uid)
            show=user.status!='invisible'
        sockets[uid].add(ws)
        await ws.send_json({'type':'authenticated'})
        if show:await emit(friends,{'type':'presence','user_id':uid,'online':True})
        while True:
            event=await ws.receive_json()
            with SessionLocal() as d:
                if moderation_state(d,uid):
                    await ws.close(code=1008);return
            if not isinstance(event,dict):continue
            if event.get('type')=='ping':await ws.send_json({'type':'pong'})
            if event.get('type')=='typing':
                cid=event.get('chat_id')
                with SessionLocal() as d:
                    if isinstance(cid,str) and d.scalar(select(Member).where(Member.chat_id==cid,Member.user_id==uid)):
                        await emit([x for x in members_of(d,cid) if x!=uid],{'type':'typing','chat_id':cid,'user_id':uid})
            if event.get('type')=='call_signal':
                to=event.get('to')
                kind=event.get('kind')
                cid=event.get('call_id')
                payload=event.get('payload') or {}
                if not isinstance(to,str) or not isinstance(cid,str) or len(cid)>60 or kind not in (
                    'invite','accept','decline','busy','offer','answer','ice','hangup','restart'):
                    continue
                if not isinstance(payload,dict) or len(json.dumps(payload))>65000:continue
                with SessionLocal() as d:
                    if to==uid or not is_friend(d,uid,to) or blocked(d,uid,to):continue
                    sender=d.get(User,uid)
                    # The destination can be on another ISP/mobile network; all signaling
                    # uses the public HTTPS/WSS server, never local LAN addresses.
                    # If the other app is closed, stop a call from ringing indefinitely.
                    if kind=='invite' and not sockets.get(to):
                        await emit([uid],{'type':'call_signal','from_id':to,
                            'nick':'Собеседник','kind':'unavailable','call_id':cid,'payload':{}})
                        continue
                    await emit([to],{'type':'call_signal','from_id':uid,'nick':sender.nick,
                         'kind':kind,'call_id':cid,'payload':payload})
    except (WebSocketDisconnect, asyncio.TimeoutError,ValueError,RuntimeError):pass
    finally:
        if uid:
            sockets[uid].discard(ws)
            if not sockets[uid]:
                with SessionLocal() as d:
                    fs=d.scalars(select(Friendship).where(Friendship.state=='accepted',((Friendship.from_id==uid)|(Friendship.to_id==uid)))).all()
                    friends=[f.to_id if f.from_id==uid else f.from_id for f in fs]
                await emit(friends,{'type':'presence','user_id':uid,'online':False})

# Serve the same MPOL interface in a normal browser as well as the Windows client.
UI_DIR = ROOT.parent / "client" / "ui"
if UI_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(UI_DIR), html=True), name="mpol-ui")
