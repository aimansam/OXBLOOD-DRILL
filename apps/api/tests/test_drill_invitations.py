"""Invite links create exactly one account on the prescribed team and drill."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from app.core.auth import sign_token
from app.db.models import User
from app.db.models_oxblood import Drill, DrillEvent, DrillInvitation, DrillParticipant
from app.db.session import get_session
from app.routers.invitations import router
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def invite_app(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'invites.sqlite'}")
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def setup():
        async with engine.begin() as conn:
            for table in (User.__table__, Drill.__table__, DrillParticipant.__table__, DrillInvitation.__table__, DrillEvent.__table__):
                await conn.run_sync(table.create)
        async with maker() as db:
            db.add(Drill(title="Red Blue Exercise", max_participants=2))
            await db.commit()
    run(setup())

    app = FastAPI()
    app.include_router(router)

    async def test_session():
        async with maker() as db:
            yield db
    app.dependency_overrides[get_session] = test_session
    with TestClient(app) as client:
        yield client, maker
    run(engine.dispose())


def auth(role="lead"):
    return {"X-Divide-Token": sign_token("operator", role, 3600)}


def issue(client, side="red"):
    return client.post("/api/v2/drills/1/invitations", json={"side": side}, headers=auth())


def test_invite_registers_prescribed_side_once(invite_app):
    client, maker = invite_app
    assert issue(client).status_code == 201
    created = issue(client, "blue")
    assert created.status_code == 201
    secret = created.json()["token"]
    listed = client.get("/api/v2/drills/1/invitations", headers=auth()).json()["invitations"]
    assert len(listed) == 2
    assert all("token" not in item for item in listed)
    assert client.post("/api/v2/invitations/preview", json={"token": secret}).json() == {
        "title": "Red Blue Exercise", "side": "blue", "expires_at": created.json()["expires_at"],
    }
    joined = client.post("/api/v2/invitations/redeem", json={
        "token": secret, "username": "new-blue", "password": "some-secret-pass",
    })
    assert joined.status_code == 201, joined.text
    assert joined.json()["role"] == "blue"
    assert joined.json()["drill_id"] == 1

    async def inspect():
        async with maker() as db:
            user = (await db.execute(select(User).where(User.sub == "new-blue"))).scalar_one()
            participant = (await db.execute(select(DrillParticipant).where(DrillParticipant.user_id == user.id))).scalar_one()
            return user, participant
    user, participant = run(inspect())
    assert user.role == "blue" and user.password_hash != "some-secret-pass"
    assert participant.drill_id == 1 and participant.role == "blue"
    assert client.post("/api/v2/invitations/redeem", json={
        "token": secret, "username": "another-blue", "password": "some-secret-pass",
    }).status_code == 404
    assert client.post("/api/v2/invitations/preview", json={"token": secret}).status_code == 404


def test_invite_authorization_revoke_and_expiry(invite_app):
    client, maker = invite_app
    assert client.post("/api/v2/drills/1/invitations", json={"side": "red"}).status_code == 401
    assert client.post("/api/v2/drills/1/invitations", json={"side": "red"}, headers=auth("blue")).status_code == 403
    assert issue(client, "green").status_code == 422
    first = issue(client).json()
    assert client.delete(f"/api/v2/drills/1/invitations/{first['id']}", headers=auth()).status_code == 200
    assert client.post("/api/v2/invitations/preview", json={"token": first["token"]}).status_code == 404
    second = issue(client).json()

    async def expire():
        async with maker() as db:
            invite = await db.get(DrillInvitation, second["id"])
            invite.expires_at = datetime.now(UTC) - timedelta(minutes=1)
            await db.commit()
    run(expire())
    assert client.post("/api/v2/invitations/redeem", json={
        "token": second["token"], "username": "late-user", "password": "some-secret-pass",
    }).status_code == 404


def test_duplicate_username_does_not_consume_link(invite_app):
    client, _ = invite_app
    first = issue(client).json()
    second = issue(client).json()
    body = {"username": "same-name", "password": "some-secret-pass"}
    assert client.post("/api/v2/invitations/redeem", json={"token": first["token"], **body}).status_code == 201
    assert client.post("/api/v2/invitations/redeem", json={"token": second["token"], **body}).status_code == 409
    assert client.post("/api/v2/invitations/preview", json={"token": second["token"]}).status_code == 200
