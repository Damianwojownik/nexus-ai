/**
 * Canonicalises common MFA phone-set variants into the compact phone inventory
 * used by Miś Engine's articulation controller.
 */
export function normaliseAlignedPhone(phone:string):string {
  let p=phone.trim();
  if(!p || ['sil','sp','spn'].includes(p)) return 'sil';

  const exact:Record<string,string>={
    'ɡ':'g',
    's̪':'s',
    'z̪':'z',
    't̪':'t',
    'd̪':'d',
    't̪s̪':'ts',
    'd̪z̪':'dz',
    'aj':'aɪ',
    'aw':'aʊ',
    'ej':'e',
    'ow':'o',
    'ɔj':'ɔʏ',
    'ʉ':'u',
    'ʊ':'u',
    'ə':'ʌ',
    'ɐ':'ʌ',
    'ɚ':'ɹ',
    'ɝ':'ɹ',
    'ɫ':'l',
    'ʒ':'ʐ',
  };
  if(exact[p]) return exact[p];

  // Remove common length/aspiration/palatalisation marks when the controller
  // does not yet model them separately.
  p=p.replace(/ː/g,'').replace(/ʰ/g,'').replace(/ʲ/g,'');
  if(exact[p]) return exact[p];

  return p;
}
