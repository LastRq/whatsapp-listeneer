export function extractMetaAdInfo(msg) {
  const m = msg.message;
  if (!m) return null;

  // Inspección recursiva de contextInfo en cualquier tipo de mensaje (audio, texto, multimedia)
  let context = m.contextInfo;
  if (!context) {
    for (const key of Object.keys(m)) {
      if (m[key] && typeof m[key] === 'object' && m[key].contextInfo) {
        context = m[key].contextInfo;
        break;
      }
    }
  }

  if (!context) return null;

  const source = String(context.entryPointConversionSource || '').toLowerCase();
  const app = String(context.entryPointConversionApp || '').toLowerCase();
  const extSource = String(context.entryPointConversionExternalSource || '').toLowerCase();
  const conversionSource = String(context.conversionSource || '').toLowerCase();

  const isMetaSource =
    source.includes('ad') ||
    source.includes('ctwa') ||
    source.includes('fb') ||
    source.includes('ig') ||
    source.includes('meta') ||
    app.includes('facebook') ||
    app.includes('instagram') ||
    extSource.includes('ad') ||
    conversionSource.includes('ad');

  const hasCtwa = Boolean(context.ctwaPayload || context.ctwaSignals);
  const hasAdReply = Boolean(context.externalAdReply || context.quotedAd);
  const hasCampaign = Boolean(context.smbServerCampaignId || context.smbClientCampaignId);

  if (isMetaSource || hasCtwa || hasAdReply || hasCampaign) {
    return {
      isAd: true,
      source: context.entryPointConversionSource || context.entryPointConversionApp || 'meta_ad',
      app: context.entryPointConversionApp || 'facebook/instagram',
      adTitle: context.externalAdReply?.title || '',
      adBody: context.externalAdReply?.body || '',
      campaignId: context.smbServerCampaignId || context.smbClientCampaignId || '',
      hasCtwaPayload: hasCtwa,
      ctwaClid: context.externalAdReply?.ctwaClid || context.ctwaClid || ''
    };
  }

  return null;
}

