"""Compare the published branch survey with a local Ministry of Health PFPB workbook."""
import argparse
import gzip
import hashlib
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile


def folded(value):
    text = unicodedata.normalize("NFKD", str(value).casefold())
    text = "".join(character for character in text if not unicodedata.combining(character))
    return " ".join(re.findall(r"[a-z0-9]+", text))


def municipal_key(city, state):
    return (folded(city), folded(state))


def program_rows(path):
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with ZipFile(path) as xlsx:
        strings = [
            "".join(text.text or "" for text in node.iter(ns + "t"))
            for node in ET.fromstring(xlsx.read("xl/sharedStrings.xml"))
        ]
        columns = {}
        for row in ET.fromstring(xlsx.read("xl/worksheets/sheet1.xml")).iter(ns + "row"):
            values = {}
            for cell in row.findall(ns + "c"):
                column = re.sub(r"[0-9]+$", "", cell.attrib["r"])
                raw = cell.findtext(ns + "v", "")
                values[column] = strings[int(raw)] if raw and cell.get("t") == "s" else raw
            if "CNPJ" in values.values():
                columns = {folded(value): key for key, value in values.items()}
                for name in ["cnpj", "municipio", "uf", "endereco"]:
                    if name not in columns:
                        raise ValueError("Unknown Ministry workbook columns")
                continue
            if columns:
                cnpj = re.sub(r"\D", "", values.get(columns["cnpj"], ""))
                if len(cnpj) == 14 and cnpj.startswith("06626253"):
                    yield (cnpj, municipal_key(values[columns["municipio"]], values[columns["uf"]]),
                           folded(values[columns["endereco"]]))
        if not columns:
            raise ValueError("Ministry workbook header missing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("survey", type=Path)
    parser.add_argument("workbook", type=Path)
    args = parser.parse_args()
    with gzip.open(args.survey, "rt", encoding="utf-8") as file:
        snapshot = json.load(file)
    addresses = set()
    cities = set()
    for store in snapshot["stores"]:
        address = store["address"]
        city = municipal_key(address["city"], address["state"])
        cities.add(city)
        addresses.add((city, folded(address["street"])))
    registered = {cnpj: (city, address) for cnpj, city, address in program_rows(args.workbook)}
    if not registered:
        raise ValueError("No Pague Menos establishments found in the supplied workbook")
    registered_cities = {city for city, address in registered.values()}
    print(json.dumps({
        "surveyObservedAt": snapshot["observedAt"],
        "programWorkbookSHA256": hashlib.sha256(args.workbook.read_bytes()).hexdigest(),
        "programEstablishments": len(registered),
        "programMunicipalities": len(registered_cities),
        "municipalitiesInBoth": len(registered_cities & cities),
        "exactCityAndStreetAddress": sum(place in addresses for place in registered.values()),
        "missingMunicipalities": sorted(registered_cities - cities),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
