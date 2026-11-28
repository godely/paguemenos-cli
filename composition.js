import { isDcbName } from 'drogasil-cli/medication-catalog';

const dosePattern = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ui)(?:\s*\/\s*(?:ml|g|dose))?\b/gi;
const normalizeDose = dose => dose.toLowerCase().replace(/\s/g, '').replace(',', '.');

// Product-level prose is usable for a single variant with one explicitly
// labeled active. Other sections can mention unrelated drugs and doses.
export function compositionEvidence(product, item, facts) {
  if (product.items?.length !== 1 || [facts.NomeSubstanciaPrincipioAtivo].flat().some(Boolean) ||
      facts['Princípio Ativo']?.length || typeof product.description !== 'string') return {};
  const sections = [...product.description.matchAll(/<h([2-4])\b[^>]*>\s*Composição\b[^<]*<\/h\1\s*>([\s\S]*?)(?=<h[1-6]\b|$)/giu)];
  if (sections.length !== 1) return {};
  const section = sections[0][2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
  if ((section.match(/princípios?\s+ativos?\s*:/giu) ?? []).length !== 1) return {};
  const label = section.match(/^Princípio ativo\s*:\s*(.+?)(?:\s+Excipientes\s*:|$)/iu)?.[1];
  if (!label) return {};
  const doses = [...label.matchAll(dosePattern)];
  if (doses.length !== 1) return {};
  const [dose] = doses;
  const name = label.slice(0, dose.index).trim();
  const titleDoses = (item.nameComplete || item.name || '').match(dosePattern) ?? [];
  if (!isDcbName(name) || !/^[.\s]*$/.test(label.slice(dose.index + dose[0].length)) ||
      titleDoses.length !== 1 || normalizeDose(titleDoses[0]) !== normalizeDose(dose[0])) return {};
  return {activeIngredients:[name], ingredientEvidence:{source:'retailer_composition', field:'Princípio ativo', url:product.link}};
}

// Only read the overview headed by this exact presentation. A prescription
// mentioned under interactions or instructions may concern a different drug.
export function descriptionEvidence(product, item, facts) {
  const result = compositionEvidence(product, item, facts);
  if (product.items?.length !== 1 || !product.link || typeof product.description !== 'string') return result;
  const overview = product.description.match(/^\s*<h([2-4])\b[^>]*>\s*O que [eé]\s+([^<>]+?)\?\s*<\/h\1\s*>([\s\S]*?)(?=<h[1-6]\b|$)/iu);
  if (!overview) return result;
  const plain = text => text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/\s+/g, ' ').trim();
  const title = item.nameComplete || item.name;
  if (!title || plain(overview[2]).toLowerCase() !== plain(title).toLowerCase()) return result;
  const text = plain(overview[3]);
  const statement = text.match(/(?:^|[.!?]\s+)(este medicamento deve ser (?:utilizado|usado|administrado) sob prescrição médica(?: e orientação profissional)?)(?:\.|$|,\s+sendo\b)/iu);
  if (statement) result.prescriptionEvidence = {
    required:true, source:'retailer_product_overview', text:statement[1], url:product.link,
  };
  return result;
}
