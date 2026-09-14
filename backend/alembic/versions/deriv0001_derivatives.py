"""Them cot asset_class cho danh muc ma va nap 4 hop dong phai sinh

Revision ID: deriv0001
Revises: mtf0001

Ma revision co tien to chu, khong phai so thu tu tiep theo.

Database dang chay cua du an da mang cac revision 0016, 0017, 0018 (tinh nang "brain") ma
working tree nay khong con ma nguon. Dat ten migration nay la "0016" se dung ma revision voi
mot migration khac da duoc ap dung that su -> alembic hong hoan toan khi hai nhanh gap nhau.
Tien to "deriv" khong the trung, giong cach "mtf0001" da lam truoc do.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'deriv0001'
down_revision: Union[str, None] = 'mtf0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


#: Bốn hợp đồng tương lai chỉ số VN30 mà mọi bảng giá trong nước đều hiển thị.
#:
#: Đây là **hợp đồng liên tục**, không phải hợp đồng có ngày đáo hạn cố định: `VN30F1M` luôn trỏ
#: tới tháng gần nhất, và khi hợp đồng đó đáo hạn thì nguồn tự chuyển chuỗi sang tháng kế. Nhờ
#: vậy danh mục không phải thêm/bớt mã mỗi tháng, và chuỗi nến không bị đứt ở mỗi kỳ đáo hạn.
#:
#: Viết cứng ở đây chứ không lấy từ nhà cung cấp vì không nguồn nào liệt kê chúng: SSI iBoard chỉ
#: trả cổ phiếu ba sàn (đã thử `/stock/exchange/derivative`, `/hnxd`, `/der` — đều rỗng). Bù lại
#: đây là một tập **cố định bốn phần tử** đã ổn định nhiều năm, không phải một danh mục sống như
#: cổ phiếu, nên viết cứng không tạo ra thứ gì phải bảo trì.
DERIVATIVES = [
    ('VN30F1M', 'Hợp đồng tương lai VN30 — tháng gần nhất'),
    ('VN30F2M', 'Hợp đồng tương lai VN30 — tháng kế tiếp'),
    ('VN30F1Q', 'Hợp đồng tương lai VN30 — quý gần nhất'),
    ('VN30F2Q', 'Hợp đồng tương lai VN30 — quý kế tiếp'),
]


def upgrade() -> None:
    # `server_default` để dòng đang có được điền ngay trong câu ALTER, không cần UPDATE riêng —
    # bảng này có hơn nghìn dòng ở các bản cài đã chạy.
    op.add_column(
        'symbols',
        sa.Column('asset_class', sa.String(length=12), nullable=False, server_default='STOCK'),
    )
    op.create_index(op.f('ix_symbols_asset_class'), 'symbols', ['asset_class'], unique=False)
    op.create_index(
        'ix_symbol_asset_active', 'symbols', ['asset_class', 'is_active'], unique=False
    )

    # Nạp hợp đồng phái sinh. `INSERT ... WHERE NOT EXISTS` chứ không `INSERT` thẳng: migration
    # phải chạy được trên cả cơ sở dữ liệu mới tinh lẫn cơ sở dữ liệu mà ai đó đã thêm tay
    # VN30F1M từ trước, và ở trường hợp sau thì `symbol` là cột duy nhất nên insert thẳng sẽ ném.
    symbols = sa.table(
        'symbols',
        sa.column('symbol', sa.String),
        sa.column('exchange', sa.String),
        sa.column('asset_class', sa.String),
        sa.column('company_name', sa.String),
        sa.column('is_active', sa.Boolean),
    )
    connection = op.get_bind()
    for code, name in DERIVATIVES:
        exists = connection.execute(
            sa.select(sa.func.count()).select_from(symbols).where(symbols.c.symbol == code)
        ).scalar()
        if exists:
            # Mã đã có (thêm tay trước đó) — chỉ gắn đúng loại tài sản, không đụng gì khác.
            connection.execute(
                symbols.update()
                .where(symbols.c.symbol == code)
                .values(asset_class='DERIVATIVE')
            )
            continue
        connection.execute(
            symbols.insert().values(
                symbol=code,
                # Phái sinh Việt Nam niêm yết trên HNX. Giữ đúng sàn thật ở đây thay vì mượn
                # cột này làm chỗ chứa loại tài sản — xem ghi chú ở `models/market.py`.
                exchange='HNX',
                asset_class='DERIVATIVE',
                company_name=name,
                is_active=True,
            )
        )


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text("DELETE FROM symbols WHERE asset_class = 'DERIVATIVE'")
    )
    op.drop_index('ix_symbol_asset_active', table_name='symbols')
    op.drop_index(op.f('ix_symbols_asset_class'), table_name='symbols')
    op.drop_column('symbols', 'asset_class')
