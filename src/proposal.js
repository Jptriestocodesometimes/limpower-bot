import { Document, Packer, Paragraph, TextRun, Header, Footer, ImageRun } from 'docx';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, 'assets');

const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

function dateByExtension(date = new Date()) {
  return `${date.getDate()} de ${MONTHS[date.getMonth()]} de ${date.getFullYear()}`;
}

const SPACING = { line: 240, lineRule: 'auto', before: 0, after: 0 };

function p(text, bold = false) {
  return new Paragraph({
    spacing: SPACING,
    children: [new TextRun({ text, font: 'Calibri', size: 24, bold })]
  });
}

function blank() {
  return new Paragraph({ spacing: SPACING, children: [] });
}

function mixed(parts) {
  return new Paragraph({
    spacing: SPACING,
    children: parts.map(({ text, bold = false }) =>
      new TextRun({ text, font: 'Calibri', size: 24, bold })
    )
  });
}

function imgParagraph(buffer, width, height) {
  return new Paragraph({
    indent: { start: -1701 },
    spacing: SPACING,
    children: [new ImageRun({ data: buffer, transformation: { width, height }, type: 'png' })]
  });
}

const DEFAULT_OBS = [
  '-Todo o material e equipamentos necessários para a execução do serviço de limpeza já estão inclusos na proposta.',
  '- Imprescindível que o local esteja livre de pessoas ou prestadores de serviços para evitar que sujem logo após a limpeza.',
  '- O local deverá possuir iluminação e água em todos os ambientes necessários.'
];

const DEFAULT_NON_INCLUDED = [
  'Remoção de entulhos.',
  'Remoção de papelão dos pisos.',
  'Remoção de proteção dos móveis.',
  'Não retiramos fitas de pintura.'
];

export async function generateProposalModelA({
  customerName,
  treatment,
  destinatarioLinha = '',
  localDescription,
  preferredDate = '',
  servicesList,
  value,
  durationDays,
  teamCount,
  teamCleaners,
  schedule = '9h às 17h',
  observations = DEFAULT_OBS,
  nonIncluded = DEFAULT_NON_INCLUDED
}) {
  const headerBuf = fs.readFileSync(path.join(ASSETS_DIR, 'header_limpower.png'));
  const footerBuf = fs.readFileSync(path.join(ASSETS_DIR, 'footer_limpower.png'));

  const firstName = customerName.trim().split(/\s+/)[0];
  const days = Number(durationDays);
  const cleaners = teamCleaners != null ? Number(teamCleaners) : Number(teamCount) - 1;

  const dayStr = days === 1 ? '01 dia' : `${String(days).padStart(2, '0')} dias`;
  const dataPrevista = preferredDate ? `${preferredDate} (${dayStr})` : `a definir (${dayStr})`;

  const children = [
    p(dateByExtension()),
    blank(),
    ...(destinatarioLinha ? [p(destinatarioLinha), blank()] : []),
    p(`${treatment} ${firstName}`),
    blank(),
    p('Segue em anexo a proposta de limpeza para o imóvel a seguir:'),
    blank(),
    p(`Local: ${localDescription}`, true),
    p(`Data prevista: ${dataPrevista}`, true),
    blank(),
    p('Serviços a serem executados:'),
    blank(),
    ...servicesList.flatMap(s => [p(s), blank()]),
    p('OBS:', true),
    blank(),
    ...observations.flatMap(o => [p(o), blank()]),
    blank(),
    blank(),
    p('-Serviços não inclusos:', true),
    blank(),
    ...nonIncluded.flatMap(n => [p(n, true), blank()]),
    blank(),
    mixed([{ text: 'Valor: ', bold: true }, { text: `R$ ${value}` }]),
    blank(),
    p(`Prazo de execução: ${dayStr} (das ${schedule})`),
    p(`Equipe: ${teamCount} pessoas (${cleaners} para a limpeza + 1 supervisora)`),
    blank(),
    blank(),
    p('Condições de pagamento: 50% no aceite e 50% após a execução e entrega do serviço.'),
    blank(),
    p('Deposito bancário ou PIX INTER'),
    blank(),
    p('LimPower Serviços de Limpeza: CNPJ: 38.235.959/0001-89 (PIX)'),
    blank(),
    blank(),
    blank(),
    blank(),
    p('Atenciosamente,'),
    blank(),
    p('Fernanda França'),
    p('(11) 98832-5990'),
    p('fernanda@limpower.com.br'),
    blank(),
    blank(),
    blank(),
    blank(),
    p('De Acordo,'),
    blank(),
    p('_________________________________')
  ];

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1417, right: 1701, bottom: 1417, left: 1701 }
        }
      },
      headers: { default: new Header({ children: [imgParagraph(headerBuf, 531, 152)] }) },
      footers: { default: new Footer({ children: [imgParagraph(footerBuf, 531, 148)] }) },
      children
    }]
  });

  return Packer.toBuffer(doc);
}

export function buildFileName({ serviceType, customerName, neighborhood, areaMq, date = new Date() }) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();

  const firstName = customerName.trim().split(/\s+/)[0];
  const bairro = (neighborhood || '').replace(/\s+/g, '_');

  const typeMap = {
    pos_obra: 'Pós_Obra',
    pre_mudanca: 'Pre_Mudanca',
    estofados: 'Estofados',
    vidros: 'Vidros'
  };
  const tipo = typeMap[serviceType] || serviceType;

  const parts = ['Proposta_Limpeza', tipo, firstName];
  if (bairro) parts.push(bairro);
  if (areaMq) parts.push(`${Math.round(areaMq)}m2`);
  parts.push(`${dd}${mm}${yyyy}`);

  return `${parts.join('_-_')}.docx`;
}
