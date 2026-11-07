"""URLs of NSE end-of-day archive files, verified 2026-11-07."""

from datetime import date

ARCHIVE = "https://nsearchives.nseindia.com"

# NSE moved the F&O bhavcopy to the UDiFF format on this date; the legacy file stops the day before.
UDIFF_START = date(2024, 7, 8)


def fo_bhavcopy_udiff(d: date) -> str:
    return f"{ARCHIVE}/content/fo/BhavCopy_NSE_FO_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"


def fo_bhavcopy_legacy(d: date) -> str:
    mon = d.strftime("%b").upper()
    return f"{ARCHIVE}/content/historical/DERIVATIVES/{d.year}/{mon}/fo{d:%d}{mon}{d.year}bhav.csv.zip"


def fo_bhavcopy_candidates(d: date) -> list[tuple[str, str]]:
    """(format, url) pairs to try in order."""
    udiff, legacy = ("udiff", fo_bhavcopy_udiff(d)), ("legacy", fo_bhavcopy_legacy(d))
    return [udiff, legacy] if d >= UDIFF_START else [legacy, udiff]


def participant_oi(d: date) -> str:
    return f"{ARCHIVE}/content/nsccl/fao_participant_oi_{d:%d%m%Y}.csv"


def participant_vol(d: date) -> str:
    return f"{ARCHIVE}/content/nsccl/fao_participant_vol_{d:%d%m%Y}.csv"


def index_close(d: date) -> str:
    return f"{ARCHIVE}/content/indices/ind_close_all_{d:%d%m%Y}.csv"
