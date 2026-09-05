"""nguon tin tu dong + anh dai dien cho tin

Revision ID: 0013
Revises: 0012
Create Date: 2026-09-01

Them bang `news_sources` (trang chuyen muc / feed duoc theo doi) va ba cot tren `news_items`:
`image_url` (anh dai dien lay tu the og:image), `source_id` (nguon da keo tin ve, NULL = nhap
tay) va `url_hash` (bam SHA-256 cua duong dan da chuan hoa, dung lam khoa chong trung).

Bam thay vi danh chi muc thang len `url`: InnoDB khong danh chi muc duy nhat duoc cho cot 1000
ky tu utf8mb4. Tin nhap tay san co cung duoc bam nguoc lai trong buoc nay, de job khong them
lai bai ma nhan vien da tu dan vao truoc do.
"""
from __future__ import annotations

import hashlib
from typing import Sequence, Union
from urllib.parse import parse_qsl, urlsplit, urlunsplit

import sqlalchemy as sa
from alembic import op

revision: str = '0013'
down_revision: Union[str, None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

PK = sa.BigInteger().with_variant(sa.Integer(), 'sqlite')

TRACKING_PARAMS = ('utm_', 'fbclid', 'gclid', 'zarsrc', 'ref_src', 'source')


def _url_hash(url: str) -> str:
    """Ban sao rut gon cua `news_sync_service.url_hash`.

    Co y chep lai chu khong import: migration phai chay dung nhu hom nay ke ca khi ham kia doi
    ve sau. Neu quy tac chuan hoa doi that thi viet migration moi de bam lai, chu khong sua
    nguoc lai file nay.
    """
    parts = urlsplit(url.strip())
    host = parts.netloc.lower().removeprefix('www.')
    path = parts.path.rstrip('/') or '/'
    query = '&'.join(
        f'{key}={value}'
        for key, value in sorted(parse_qsl(parts.query, keep_blank_values=True))
        if not key.lower().startswith(TRACKING_PARAMS)
    )
    clean = urlunsplit((parts.scheme.lower(), host, path, query, ''))
    return hashlib.sha256(clean.encode('utf-8')).hexdigest()


def upgrade() -> None:
    op.create_table(
        'news_sources',
        sa.Column('id', PK, nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('url', sa.String(length=1000), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('max_items', sa.Integer(), nullable=False, server_default='10'),
        sa.Column('last_fetched_at', sa.DateTime(), nullable=True),
        sa.Column('last_status', sa.String(length=20), nullable=True),
        sa.Column('last_error', sa.String(length=500), nullable=True),
        sa.Column('item_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_by', PK, nullable=True),
        sa.Column('created_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_news_sources_is_active', 'news_sources', ['is_active'])

    op.add_column('news_items', sa.Column('image_url', sa.String(length=1000), nullable=True))
    op.add_column('news_items', sa.Column('source_id', PK, nullable=True))
    op.add_column('news_items', sa.Column('url_hash', sa.String(length=64), nullable=True))
    op.create_index('ix_news_items_source_id', 'news_items', ['source_id'])

    # Bam cac tin nhap tay san co truoc khi bat chi muc duy nhat. Neu du lieu cu da co hai dong
    # cung mot duong dan thi buoc tao chi muc ben duoi se bao loi — do la y muon: phai xoa dong
    # trung bang tay roi chay lai, chu khong im lang bo qua.
    bind = op.get_bind()
    rows = bind.execute(sa.text('SELECT id, url FROM news_items')).fetchall()
    for row_id, url in rows:
        if not url:
            continue
        bind.execute(
            sa.text('UPDATE news_items SET url_hash = :h WHERE id = :i'),
            {'h': _url_hash(url), 'i': row_id},
        )

    op.create_index('uq_news_url_hash', 'news_items', ['url_hash'], unique=True)
    op.create_foreign_key(
        'fk_news_items_source', 'news_items', 'news_sources',
        ['source_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_news_items_source', 'news_items', type_='foreignkey')
    op.drop_index('uq_news_url_hash', table_name='news_items')
    op.drop_index('ix_news_items_source_id', table_name='news_items')
    op.drop_column('news_items', 'url_hash')
    op.drop_column('news_items', 'source_id')
    op.drop_column('news_items', 'image_url')
    op.drop_index('ix_news_sources_is_active', table_name='news_sources')
    op.drop_table('news_sources')
