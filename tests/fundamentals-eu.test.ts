import { describe, expect, it } from "vitest";
import type { Dataset } from "../src/core/datasets.js";
import { amfInsiderDeclarations, classifyNature, frenchDate, parseAmfDeclaration, parseBdifSearch } from "../src/providers/fundamentals/amf.js";
import { consolidatedFacts, esefEntities, esefFundamentals, parseEsefFilings, parseEsefReport } from "../src/providers/fundamentals/esef.js";
import { gleifByIsin, gleifSearch, parseLeiRecords } from "../src/providers/fundamentals/gleif.js";
import { figiJobFor, openfigiIdentifiers, parseFigiResponse, preferredFigi } from "../src/providers/fundamentals/openfigi.js";
import { withFixture } from "./helpers/fixtures.js";

const point = (ds: Dataset, key: string) => ds.points.find((p) => p.key === key);

// What the engine's pdfToText reads from a real declaration (2026DD1122439), trimmed.
const DD_TEXT =
  "2026DD1122439 FR0000121014 - DD192973 23 juin 2026 INFORMATION Déclaration individuelle relative aux opérations des personnes mentionnées à l’article L.621-18-2 du Code monétaire et financier sur les titres de la société LA PRESENTE NOTIFICATION N’A PAS FAIT L’OBJET D’UN CONTROLE DE L’AMF ET EST ETABLIE SOUS LA RESPONSABILITE EXCLUSIVE DU DECLARANT. NOM /FONCTION DE LA PERSONNE EXERCANT DES RESPONSABILITES DIRIGEANTES OU DE LA PERSONNE ETROITEMENT LIEE : ANTOINE ARNAULT, Membre du Conseil d'administration NOTIFICATION INITIALE / MODIFICATION: Notification initiale COORDONNEES DE L’EMETTEUR NOM : LVMH MOET HENNESSY-LOUIS VUITTON LEI : IOG4E947OATN0KJYSD45 DETAIL DE LA TRANSACTION DATE DE LA TRANSACTION : 22 juin 2026 LIEU DE LA TRANSACTION : Hors plateforme de négociation NATURE DE LA TRANSACTION : Nantissement d'un compte-titres DESCRIPTION DE L’INSTRUMENT FINANCIER : Action CODE D’IDENTIFICATION DE L’INSTRUMENT FINANCIER : FR0000121014 INFORMATION DETAILLEE PAR OPERATION PRIX UNITAIRE : 0.0000 Euro VOLUME : 50 000.0000 INFORMATIONS AGREGEES PRIX : 0.0000 Euro VOLUME : 50 000.0000 TRANSACTION LIEE A L’EXERCICE DE PROGRAMMES D’OPTIONS SUR ACTIONS OU SUR UNE ATTRIBUTION D’ACTIONS GRATUITES OU DE PERFORMANCES : NON DATE DE RECEPTION DE LA NOTIFICATION : 23 juin 2026 COMMENTAIRES :";

describe("EU parsers", () => {
  it("reads an AMF declaration's text: declarant, nature, date, price, volume", () => {
    const d = parseAmfDeclaration(DD_TEXT);
    expect(d.declarant).toBe("ANTOINE ARNAULT, Membre du Conseil d'administration");
    expect(d.transactions).toEqual([
      {
        date: "2026-06-22",
        nature: "Nantissement d'un compte-titres",
        side: "pledge",
        venue: "Hors plateforme de négociation",
        isin: "FR0000121014",
        price: 0,
        currency: "EUR",
        volume: 50000,
      },
    ]);
    const two = parseAmfDeclaration(
      DD_TEXT.replace("Nantissement d'un compte-titres", "Acquisition").replace(/PRIX : 0\.0000 Euro/, "PRIX : 512.3000 Euro") +
        " DETAIL DE LA TRANSACTION DATE DE LA TRANSACTION : 1er août 2026 NATURE DE LA TRANSACTION : Cession INFORMATIONS AGREGEES PRIX : 600.00 Euro VOLUME : 10.0000",
    );
    expect(two.transactions.map((t) => [t.side, t.date, t.price, t.volume])).toEqual([
      ["buy", "2026-06-22", 512.3, 50000],
      ["sell", "2026-08-01", 600, 10],
    ]);
    expect(frenchDate("3 décembre 2025")).toBe("2025-12-03");
    expect(classifyNature("Souscription")).toBe("subscription");
    expect(classifyNature("Autre")).toBe("other");
  });

  it("reads BDIF search results with their PDF links", () => {
    const refs = parseBdifSearch({
      result: [
        {
          numero: "2026DD1",
          dateInformation: "2026-06-01T00:00:00",
          datePublication: "2026-06-01T18:00:00+02:00",
          documents: [{ path: "2026/2026DD1/AB.pdf", accessible: true }],
          societes: [{ jeton: "RS00001689", raisonSociale: "LVMH" }],
        },
        { numero: "2026DD2", dateInformation: "2026-06-03T00:00:00", documents: [], societes: [] },
      ],
    });
    expect(refs.map((r) => r.numero)).toEqual(["2026DD2", "2026DD1"]);
    expect(refs[1]).toMatchObject({ pdfUrl: "https://bdif.amf-france.org/back/api/v1/documents/2026/2026DD1/AB.pdf", issuerIds: ["RS00001689"] });
  });

  it("reads xBRL-JSON facts: consolidated only, midnight-after dates undone", () => {
    const json = {
      facts: {
        a: {
          value: "100",
          decimals: -6,
          dimensions: { concept: "ifrs-full:Revenue", entity: "e", period: "2024-01-01T00:00:00/2025-01-01T00:00:00", unit: "iso4217:EUR" },
        },
        b: { value: "90", dimensions: { concept: "ifrs-full:Revenue", entity: "e", period: "2023-01-01T00:00:00/2024-01-01T00:00:00", unit: "iso4217:EUR" } },
        c: {
          value: "7",
          dimensions: {
            concept: "ifrs-full:Revenue",
            entity: "e",
            period: "2024-01-01T00:00:00/2025-01-01T00:00:00",
            unit: "iso4217:EUR",
            "ifrs-full:SegmentsAxis": "x",
          },
        },
        d: { value: "500", dimensions: { concept: "ifrs-full:Assets", entity: "e", period: "2025-01-01T00:00:00", unit: "iso4217:EUR" } },
        e: { value: "200", dimensions: { concept: "ifrs-full:NoncurrentLiabilities", entity: "e", period: "2025-01-01T00:00:00", unit: "iso4217:EUR" } },
        f: { value: "100", dimensions: { concept: "ifrs-full:CurrentLiabilities", entity: "e", period: "2025-01-01T00:00:00", unit: "iso4217:EUR" } },
        g: {
          value: "40",
          dimensions: {
            concept: "ifrs-full:CashFlowsFromUsedInOperatingActivities",
            entity: "e",
            period: "2024-01-01T00:00:00/2025-01-01T00:00:00",
            unit: "iso4217:EUR",
          },
        },
        h: {
          value: "-15",
          dimensions: {
            concept: "ifrs-full:PurchaseOfPropertyPlantAndEquipment",
            entity: "e",
            period: "2024-01-01T00:00:00/2025-01-01T00:00:00",
            unit: "iso4217:EUR",
          },
        },
        i: {
          value: "2.5",
          dimensions: {
            concept: "ifrs-full:BasicEarningsLossPerShare",
            entity: "e",
            period: "2024-01-01T00:00:00/2025-01-01T00:00:00",
            unit: "iso4217:EUR/xbrli:shares",
          },
        },
      },
    };
    expect(consolidatedFacts(json)).toHaveLength(8);
    const { metrics } = parseEsefReport(json);
    const by = (id: string) => metrics.find((m) => m.id === id)?.values;
    expect(by("revenue")?.map((v) => [v.period, v.end, v.value])).toEqual([
      ["FY2024", "2024-12-31", 100],
      ["FY2023", "2023-12-31", 90],
    ]);
    expect(by("assets")?.[0]).toMatchObject({ end: "2024-12-31", value: 500, unit: "EUR" });
    expect(by("liabilities")?.[0]).toMatchObject({ value: 300, formula: "NoncurrentLiabilities + CurrentLiabilities" });
    expect(by("freeCashFlow")?.[0]).toMatchObject({ value: 25 });
    expect(by("epsBasic")?.[0]).toMatchObject({ value: 2.5, unit: "EUR" });
  });

  it("reads the filings index, GLEIF records and OpenFIGI answers", () => {
    const filings = parseEsefFilings({
      data: [
        { id: "1", attributes: { period_end: "2021-12-31", fxo_id: "LEI1-2021", date_added: "2022-03-31 00:00:00", json_url: "/a.json", error_count: 0 } },
        { id: "2", attributes: { period_end: "2024-12-31", fxo_id: "LEI1-2024", date_added: "2025-04-15 12:08:42", json_url: "/b.json", error_count: 2 } },
      ],
    });
    expect(filings.map((f) => [f.periodEnd, f.added, f.jsonUrl])).toEqual([
      ["2024-12-31", "2025-04-15", "https://filings.xbrl.org/b.json"],
      ["2021-12-31", "2022-03-31", "https://filings.xbrl.org/a.json"],
    ]);
    expect(
      parseLeiRecords({ data: [{ id: "IOG4E947OATN0KJYSD45", attributes: { entity: { legalName: { name: "LVMH" }, legalAddress: { country: "FR" } } } }] })[0],
    ).toMatchObject({
      lei: "IOG4E947OATN0KJYSD45",
      country: "FR",
    });
    expect(figiJobFor("037833100")).toEqual({ idType: "ID_CUSIP", idValue: "037833100", exchCode: "US" });
    expect(figiJobFor("fr0000121014").idType).toBe("ID_ISIN");
    const parsed = parseFigiResponse([
      {
        data: [
          { figi: "G", ticker: "MOH", exchCode: "GR", compositeFIGI: "G" },
          { figi: "F", ticker: "MC", exchCode: "FP", compositeFIGI: "F" },
        ],
      },
      { warning: "No identifier found." },
    ]);
    expect(preferredFigi(parsed[0], "FR0000121014")?.ticker).toBe("MC");
    expect(preferredFigi(parsed[0])?.ticker).toBe("MOH");
    expect(parsed[1]).toBeUndefined();
  });
});

describe("EU fixtures", () => {
  it("replays LVMH: ISIN → LEI (GLEIF) → its ESEF report known by end-2022", async () => {
    await withFixture("fundamentals-esef-lvmh", async () => {
      const lei = await gleifByIsin("FR0000121014");
      expect(point(lei, "FR0000121014.lei")).toMatchObject({ value: "IOG4E947OATN0KJYSD45" });
      expect(point(lei, "FR0000121014.legalName")?.untrusted).toBe(true);
      expect(lei.provenance.official).toBe(true);
      const ds = await esefFundamentals("FR0000121014", { asOf: "2022-12-31", subject: "MC.PA" });
      expect(ds.provenance).toMatchObject({ source: "esef", official: true, asOf: "2021-12-31" });
      expect(point(ds, "MC.PA.fund.revenue.FY2021")).toMatchObject({ value: 64215000000, unit: "EUR", asOf: "2021-12-31" });
      expect(point(ds, "MC.PA.fund.revenue.FY2020")).toBeDefined();
      expect(point(ds, "MC.PA.fund.epsDiluted.FY2021")?.unit).toBe("EUR");
      expect(point(ds, "MC.PA.fund.liabilities.FY2021")?.formula).toBe("NoncurrentLiabilities + CurrentLiabilities");
      expect(ds.notes.join(" ")).toMatch(/excluded by asOf/);
      const cands = await gleifSearch("LVMH", { limit: 3 });
      expect(cands.points.filter((p) => p.key.endsWith(".lei"))).toHaveLength(3);
      const ents = await esefEntities("lvmh");
      expect(point(ents, "ESEF.search.1.lei")?.value).toBe("IOG4E947OATN0KJYSD45");
    });
  }, 60_000);

  it("replays LVMH managers' declarations from the AMF, PDFs read", async () => {
    await withFixture("fundamentals-amf-lvmh", async () => {
      const ds = await amfInsiderDeclarations("FR0000121014", { limit: 3, subject: "MC.PA" });
      expect(ds.provenance).toMatchObject({ source: "amf-bdif", official: true });
      const decl = ds.points.filter((p) => p.key.endsWith(".declarant"));
      expect(decl).toHaveLength(3);
      expect(decl.every((p) => p.untrusted)).toBe(true);
      const sides = ds.points.filter((p) => p.key.endsWith(".side"));
      expect(sides.length).toBeGreaterThanOrEqual(3);
      expect(sides.every((p) => ["buy", "sell", "subscription", "exercise", "grant", "pledge", "other"].includes(String(p.value)))).toBe(true);
      expect(ds.points.some((p) => p.key.endsWith(".volume") && p.unit === "shares")).toBe(true);
      expect(ds.notes.join(" ")).not.toMatch(/details unavailable/);
    });
  }, 60_000);

  it("replays an OpenFIGI mapping of a CUSIP and an ISIN", async () => {
    await withFixture("fundamentals-openfigi", async () => {
      const ds = await openfigiIdentifiers(["037833100", "FR0000121014"]);
      expect(point(ds, "037833100.figi.ticker")?.value).toBe("AAPL");
      expect(point(ds, "FR0000121014.figi.ticker")?.value).toBe("MC");
      expect(ds.provenance.official).toBe(false);
    });
  }, 60_000);
});
