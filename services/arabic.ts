/**
 * ARABIC UI STRINGS.
 *
 * Keyed by the English source string, so a call site reads `t('Generate')` and
 * a string with no entry here renders in English rather than as a raw key. See
 * `services/uiPrefs.tsx` for why that trade was made.
 *
 * NOTHING TECHNICAL BELONGS IN THIS FILE. Product names, folder and file names,
 * ids, model ids, view names that reach the prompt (FRONT / BACK / LEFT /
 * RIGHT / SOLE / TOP), the style directives, and anything stored in or read
 * from the Library are values, not copy — they are never translated. Where such
 * a value is shown inside Arabic text it is wrapped in `ltrClass` so it keeps
 * left-to-right order.
 */

export const AR: Record<string, string> = {
  // ── shell, navigation, identity ──────────────────────────────────────────
  'AI Try-On Studio': 'استوديو القياس الافتراضي',
  'AI Virtual Try-On Studio': 'استوديو القياس الافتراضي بالذكاء الاصطناعي',
  'AI Virtual Try-On': 'القياس الافتراضي بالذكاء الاصطناعي',
  'Virtual apparel & footwear visualization': 'عرض الملابس والأحذية افتراضيًا',
  Studio: 'الاستوديو',
  Library: 'المكتبة',
  'Main navigation': 'التنقل الرئيسي',
  Settings: 'الإعدادات',
  'Powered by': 'مدعوم من',
  'Toggle Advanced Settings Drawer': 'إظهار أو إخفاء الإعدادات المتقدمة',
  'Upload your footwear or athletic apparel and visualize them instantly on a model using Gemini AI.':
    'ارفع الحذاء أو الملابس الرياضية وشاهدها على العارض فورًا باستخدام Gemini.',
  'Every image generated in the Studio, saved permanently — browse, filter and search past renders.':
    'كل صورة تُنشأ في الاستوديو تُحفظ بشكل دائم — تصفّح واعرض وابحث في الأعمال السابقة.',

  // ── language / theme switchers ───────────────────────────────────────────
  Language: 'اللغة',
  Theme: 'المظهر',
  English: 'English',
  Arabic: 'العربية',
  Light: 'فاتح',
  Dark: 'داكن',
  'Switch language': 'تغيير اللغة',
  'Switch theme': 'تغيير المظهر',

  // ── uploads and inputs ───────────────────────────────────────────────────
  'Athlete Photo': 'صورة العارض',
  'Face and body are preserved': 'يتم الحفاظ على الوجه والجسم',
  'Google Drive': 'Google Drive',
  'Connect Google Drive': 'ربط Google Drive',
  Disconnect: 'قطع الاتصال',
  'Access athlete & gear photos directly from your Google Drive':
    'الوصول إلى صور العارض والمنتجات مباشرة من Google Drive',
  'Remove image': 'إزالة الصورة',
  'Replace image': 'استبدال الصورة',
  Replace: 'استبدال',
  'Selected item': 'العنصر المحدد',
  'Upload several — sorted into slots': 'ارفع عدة صور — تُوزَّع على الخانات',
  'More photos of this person': 'صور إضافية لنفس الشخص',
  'More angles of this shoe — same pair, different views':
    'زوايا إضافية لنفس الحذاء — الزوج نفسه من جهات مختلفة',
  'Shirt / top — FRONT first, then the BACK of the same garment':
    'القميص / القطعة العلوية — الأمام أولًا ثم الخلف لنفس القطعة',
  'Pants / bottoms — FRONT first, then the BACK of the same garment':
    'البنطال / القطعة السفلية — الأمام أولًا ثم الخلف لنفس القطعة',
  'Loading photos & folders...': 'جارٍ تحميل الصور والمجلدات...',
  'No photos found in this view': 'لا توجد صور في هذا العرض',
  'My Drive Folders': 'مجلدات Drive',
  'All Photos (Entire Drive)': 'كل الصور (Drive بالكامل)',
  'All Folders': 'كل المجلدات',
  'Importing...': 'جارٍ الاستيراد...',
  Folder: 'مجلد',
  'Manual Slots': 'خانات يدوية',
  Apparel: 'ملابس',
  Footwear: 'أحذية',
  'Footwear & Product Detail Shots': 'لقطات الأحذية وتفاصيل المنتج',

  // ── scene and settings ───────────────────────────────────────────────────
  'Model + Background': 'العارض والخلفية',
  'Background Scene': 'مشهد الخلفية',
  'Background Scene Location': 'موقع مشهد الخلفية',
  'Lighting Reference': 'مرجع الإضاءة',
  'Atmospheric Lighting Reference': 'مرجع الإضاءة والأجواء',
  'Copies mood and colour': 'ينقل الأجواء واللون',
  'Custom Backdrop Mode': 'وضع الخلفية المخصصة',
  'Generation Settings': 'إعدادات الإنشاء',
  Generation: 'الإنشاء',
  Advanced: 'متقدم',
  'Advanced Settings Drawer': 'لوحة الإعدادات المتقدمة',
  'Close settings drawer': 'إغلاق لوحة الإعدادات',
  'Close settings drawer overlay': 'إغلاق طبقة لوحة الإعدادات',
  'AI Provider:': 'مزوّد الذكاء الاصطناعي:',
  'Gemini model:': 'نموذج Gemini:',
  Active: 'مفعّل',
  'Low Resolution': 'دقة منخفضة',
  'Images / Angles': 'الصور / الزوايا',
  'Editing Prompt': 'تعديل التوجيه',
  'Customizing prompt for': 'تعديل التوجيه الخاص بـ',
  'Advanced Scene Prompt (': 'توجيه المشهد المتقدم (',
  'Click any angle option above to edit its prompt': 'اختر أي زاوية بالأعلى لتعديل توجيهها',

  // ── generation and batch ─────────────────────────────────────────────────
  'AI Visualization Engine Running': 'محرك التوليد قيد التشغيل',
  'Batch Generation': 'إنشاء دفعة',
  'Individual products': 'منتجات منفردة',
  'One image per ticked product per shot — only that product changes.':
    'صورة واحدة لكل منتج محدد لكل لقطة — لا يتغير سوى ذلك المنتج.',
  'Confirm grouping': 'تأكيد التجميع',
  'New product': 'منتج جديد',
  'Move to another product': 'نقل إلى منتج آخر',
  'Move to…': 'نقل إلى…',
  'Add to…': 'إضافة إلى…',
  'Merge into…': 'دمج مع…',
  'Merge this product into another': 'دمج هذا المنتج مع منتج آخر',
  'Delete product (photos return to the tray)': 'حذف المنتج (تعود الصور إلى الدرج)',
  'Duplicate this outfit': 'تكرار هذا الطقم',
  Category: 'الفئة',
  'Copy why each photo landed where it did': 'نسخ سبب توزيع كل صورة',
  'No athlete photo is loaded': 'لم يتم رفع صورة العارض',

  // ── results and library ──────────────────────────────────────────────────
  'Generated render': 'الصورة المُولَّدة',
  'Click to compare with the product reference': 'اضغط للمقارنة مع صورة المنتج المرجعية',
  'Long-press to save': 'اضغط مطولًا للحفظ',
  'Image unavailable': 'الصورة غير متاحة',
  'Drag the yellow edges to trim the top and bottom': 'اسحب الحواف الصفراء لقص الأعلى والأسفل',
  'Trim from the top': 'قص من الأعلى',
  'Trim from the bottom': 'قص من الأسفل',
  'Bundle all renders into a single ZIP folder': 'تجميع كل الصور في ملف ZIP واحد',
  'Delete from Library': 'حذف من المكتبة',
  Approved: 'معتمد',
  'Approved only': 'المعتمدة فقط',
  'Approval not saved to the Library': 'لم يُحفظ الاعتماد في المكتبة',
  'Not saved to the Library': 'لم يُحفظ في المكتبة',
  'Dismiss Library warning': 'إخفاء تنبيه المكتبة',
  'Dismiss approval warning': 'إخفاء تنبيه الاعتماد',
  'End of the Library': 'نهاية المكتبة',
  'Load more': 'تحميل المزيد',
  'Loading more…': 'جارٍ تحميل المزيد…',
  'Newest first': 'الأحدث أولًا',
  'Oldest first': 'الأقدم أولًا',
  'Date range': 'النطاق الزمني',
  'From date': 'من تاريخ',
  'Clear filters': 'مسح عوامل التصفية',
  'Clear search': 'مسح البحث',
  Distinctive: 'مميّز',

  // ── generic controls ─────────────────────────────────────────────────────
  All: 'الكل',
  Back: 'رجوع',
  Cancel: 'إلغاء',
  Check: 'تحقق',
  Clear: 'مسح',
  'Clear all': 'مسح الكل',
  Close: 'إغلاق',
  'Close (Esc)': 'إغلاق (Esc)',
  'Next (→)': 'التالي (→)',
  Moving: 'جارٍ النقل',
  'Optimizing…': 'جارٍ التحسين…',
  'These tiles are in': 'هذه الخانات مرتبة حسب',

  // ── product grouping & review ────────────────────────────────────────────
  'Review grouping': 'مراجعة التجميع',
  'Check the grouping before rendering — each product is generated only from its own photos.':
    'راجع التجميع قبل الإنشاء — كل منتج يُولَّد من صوره وحدها.',
  Product: 'منتج',
  Products: 'المنتجات',
  'Product / Outfit': 'المنتج / الطقم',
  'Product reference': 'صورة المنتج المرجعية',
  'Remove from this product': 'إزالة من هذا المنتج',
  'Pick this photo, then split it out': 'اختر هذه الصورة ثم افصلها',
  'What this photo showed': 'ما أظهرته هذه الصورة',
  'The photographs of this product did not agree about this':
    'صور هذا المنتج لم تتفق على هذه الخاصية',
  'The photos could not be sorted.': 'تعذّر فرز الصور.',
  'Stop sorting — keep what is done': 'إيقاف الفرز — مع الإبقاء على ما تم',
  'None in this folder — set a product\'s category in Review.':
    'لا شيء في هذا المجلد — حدّد فئة المنتج من صفحة المراجعة.',

  // ── outfits ──────────────────────────────────────────────────────────────
  Outfits: 'الأطقم',
  'Outfit name': 'اسم الطقم',
  'Remove this outfit': 'إزالة هذا الطقم',
  'Compose outfits (shirt + pants + shoes) — one image per outfit per shot.':
    'كوّن أطقمًا (قميص + بنطال + حذاء) — صورة واحدة لكل طقم في كل لقطة.',
  'Drag onto a line. One product can go on many lines.':
    'اسحب إلى أحد الصفوف. يمكن للمنتج الواحد أن يظهر في عدة صفوف.',
  'Remove — this slot is then rendered plain': 'إزالة — تُنشأ هذه الخانة بدون منتج',

  // ── generation, batch, quality ───────────────────────────────────────────
  Render: 'إنشاء',
  Start: 'ابدأ',
  'Start this batch?': 'بدء هذه الدفعة؟',
  Retry: 'إعادة المحاولة',
  Reset: 'إعادة تعيين',
  'Reset Default': 'استعادة الافتراضي',
  Refresh: 'تحديث',
  Prompt: 'التوجيه',
  'Shot / Angle': 'اللقطة / الزاوية',
  'Shoe shots': 'لقطات الحذاء',
  'Quality:': 'الجودة:',
  'Standard (1K) — recommended': 'قياسية (1K) — موصى بها',
  'Premium (2K) — slower': 'متقدمة (2K) — أبطأ',
  'Studio (4K) — slowest': 'استوديو (4K) — الأبطأ',
  'Generating photorealistic footwear texture, lighting, and camera perspective...':
    'جارٍ توليد ملمس الحذاء والإضاءة ومنظور الكاميرا بواقعية...',
  'Sends exactly one more request for this item, on the same model.':
    'يُرسل طلبًا واحدًا إضافيًا لهذا العنصر، على العارض نفسه.',
  'Sends exactly one more request for this shot, on the same model.':
    'يُرسل طلبًا واحدًا إضافيًا لهذه اللقطة، على العارض نفسه.',
  'Sends only the pending items. Nothing already attempted is sent again.':
    'يُرسل العناصر المعلّقة فقط، ولا يُعاد إرسال ما جرت محاولته.',
  'Sneaker-only shots are skipped for apparel products, so the total is lower than the plain multiplication.':
    'تُتخطى لقطات الحذاء وحده لمنتجات الملابس، لذلك يقل الإجمالي عن حاصل الضرب المباشر.',
  'What the model actually replied:': 'ما ردّ به النموذج فعليًا:',
  'System Notification': 'إشعار النظام',
  'Remove scene': 'إزالة المشهد',
  'Showroom, gym, track…': 'صالة عرض، نادٍ رياضي، مضمار…',

  // ── library & drive ──────────────────────────────────────────────────────
  'Your AI Visualization Gallery': 'معرض أعمالك بالذكاء الاصطناعي',
  Search: 'بحث',
  Sort: 'الترتيب',
  'To date': 'إلى تاريخ',
  'Show approved generations only': 'عرض المعتمدة فقط',
  'Share / Save Active View': 'مشاركة / حفظ العرض الحالي',
  'Select Footwear & Apparel': 'اختر الأحذية والملابس',
  'Upload Folder': 'رفع مجلد',
  'Whole folder, many products': 'مجلد كامل، منتجات متعددة',
  'Up one folder': 'مجلد للأعلى',
  Starred: 'المميّزة بنجمة',
  'Shared with Me': 'مشارَك معي',
  'Search photos & folders in Google Drive...': 'ابحث في الصور والمجلدات في Google Drive...',
  'Reconnect & Grant Access': 'إعادة الاتصال ومنح الإذن',
  'You need to upgrade permissions to see all folders.':
    'تحتاج إلى ترقية الأذونات لرؤية كل المجلدات.',
  'Powered by Google Workspace API': 'مدعوم من Google Workspace API',

  // ── status, progress and the engine ──────────────────────────────────────
  'Processing multi-angle render request...': 'جارٍ تنفيذ طلب الإنشاء متعدد الزوايا...',
  'Batch queued — {n} render(s) waiting to start': 'الدفعة في الانتظار — {n} صورة بانتظار البدء',
  'Batch running — {done} of {total} render(s) done':
    'الدفعة قيد التنفيذ — اكتملت {done} من {total}',
  'Preparing the batch{wave}…': 'جارٍ تحضير الدفعة{wave}…',
  'Submitting {n} render(s) as one batch{wave}…': 'جارٍ إرسال {n} صورة كدفعة واحدة{wave}…',
  'Rendering Angle {i} of {n}: {style}...': 'جارٍ إنشاء الزاوية {i} من {n}: {style}...',
  'Reconnecting to a batch already running…': 'جارٍ إعادة الاتصال بدفعة قيد التنفيذ…',
  'Stopping after this one…': 'سيتم الإيقاف بعد هذه الصورة…',
  Stop: 'إيقاف',
  'The render in flight finishes; nothing after it is sent.':
    'تكتمل الصورة الجارية حاليًا، ولا يُرسل أي شيء بعدها.',
  'Generating...': 'جارٍ الإنشاء...',
  'Try On Now': 'جرّبه الآن',
  'Saving…': 'جارٍ الحفظ…',
  'Deleting…': 'جارٍ الحذف…',
  'Adding…': 'جارٍ الإضافة…',

  // ── errors and failures ──────────────────────────────────────────────────
  'Failed to sign in with Google.': 'تعذّر تسجيل الدخول عبر Google.',
  'The batch reported this render as failed.': 'أبلغت الدفعة عن فشل هذه الصورة.',
  'The batch finished but returned no pictures. Nothing was resubmitted.':
    'انتهت الدفعة دون إرجاع أي صور، ولم يُعد إرسال أي شيء.',
  'The batch submission failed.': 'فشل إرسال الدفعة.',
  'Every render in this batch failed. Nothing was retried.':
    'فشلت كل الصور في هذه الدفعة، ولم تُعد المحاولة.',
  'The batch that was still running returned no pictures.':
    'الدفعة التي كانت قيد التنفيذ لم تُرجع أي صور.',
  'Please select at least one camera shot angle.': 'اختر زاوية تصوير واحدة على الأقل.',
  'Compose at least one outfit with a product in it.':
    'كوّن طقمًا واحدًا على الأقل يحتوي على منتج.',
  'None of these outfits can use the shots you selected. Pick an outfit shot, or add shoes to an outfit for the sneaker shots.':
    'لا يمكن لأي من هذه الأطقم استخدام اللقطات المحددة. اختر لقطة طقم، أو أضف حذاءً إلى أحد الأطقم للقطات الحذاء.',
  'Could not prepare these outfits.': 'تعذّر تحضير هذه الأطقم.',
  'Tick at least one product to render.': 'حدّد منتجًا واحدًا على الأقل للإنشاء.',
  'None of these products can use the shots you selected. Pick an outfit shot as well.':
    'لا يمكن لأي من هذه المنتجات استخدام اللقطات المحددة. اختر لقطة طقم أيضًا.',
  'Could not prepare this batch.': 'تعذّر تحضير هذه الدفعة.',
  'Please upload at least one footwear or apparel item first.':
    'ارفع أولًا عنصرًا واحدًا على الأقل من الأحذية أو الملابس.',
  'Unknown error.': 'خطأ غير معروف.',
  'No image was returned.': 'لم تُرجَع أي صورة.',
  'An unexpected error occurred.': 'حدث خطأ غير متوقع.',
  'Could not load the Library.': 'تعذّر تحميل المكتبة.',
  'Could not load more.': 'تعذّر تحميل المزيد.',
  'Download failed.': 'فشل التنزيل.',
  'Approval failed.': 'فشل الاعتماد.',
  'Delete failed.': 'فشل الحذف.',
  'The analysis did not run.': 'لم يُنفَّذ التحليل.',
  'Failed to fetch files from Google Drive': 'تعذّر جلب الملفات من Google Drive',
  'Failed to sign in with Google Drive': 'تعذّر تسجيل الدخول إلى Google Drive',

  // ── studio — hints, controls, results ────────────────────────────────────
  'no API key': 'لا يوجد مفتاح API',
  'Google — uses GEMINI_API_KEY': 'Google — يستخدم GEMINI_API_KEY',
  'needs OPENAI_API_KEY': 'يحتاج إلى OPENAI_API_KEY',
  'Custom Backdrop Active': 'الخلفية المخصصة مفعّلة',
  'Standard Studio Active': 'الاستوديو القياسي مفعّل',
  'Compose an outfit below, then pick a shot.': 'كوّن طقمًا بالأسفل، ثم اختر لقطة.',
  'Now pick the shot you want below, then hit Render.':
    'اختر الآن اللقطة التي تريدها بالأسفل، ثم اضغط إنشاء.',
  'Tick the products you want, then pick a shot below.':
    'حدّد المنتجات التي تريدها، ثم اختر لقطة بالأسفل.',
  'Untick all': 'إلغاء تحديد الكل',
  'Tick all': 'تحديد الكل',
  'Select All': 'تحديد الكل',
  'Render {name}': 'إنشاء {name}',
  'Preview draft — cheapest; loses fine detail': 'مسودة معاينة — الأرخص؛ تفقد التفاصيل الدقيقة',
  'Hide Prompt': 'إخفاء التوجيه',
  'Customize Prompt': 'تخصيص التوجيه',
  Angle: 'زاوية',
  Angles: 'زوايا',
  'Manual upload': 'رفع يدوي',
  'Scene: your athlete photo — background built by the engine':
    'المشهد: صورة العارض التي رفعتها — الخلفية من إنشاء المحرك',
  'Scene: GENERATED — no athlete photo reached this render':
    'المشهد: مُولَّد — لم تصل أي صورة عارض إلى هذه الصورة',
  'none for this camera angle': 'لا شيء لهذه الزاوية',
  'Previous (←)': 'السابق (←)',
  'Approved ✓': 'معتمد ✓',
  Approve: 'اعتماد',
  Shirt: 'قميص',
  Pants: 'بنطال',
  Shoes: 'حذاء',
  'nothing supplied': 'لم يُرفع أي شيء',
  'Each outfit is rendered exactly as composed — a slot left empty is rendered plain and unbranded. Nothing is combined for you.':
    'يُنشأ كل طقم كما كوّنته تمامًا — والخانة المتروكة فارغة تُنشأ بلا منتج وبلا علامة تجارية. لا يُدمج شيء نيابةً عنك.',
  'Each product is rendered alone, from its own photos, in its own slot — every other garment is rendered plain.':
    'يُنشأ كل منتج بمفرده من صوره الخاصة في خانته — وتُنشأ بقية القطع بلا علامة تجارية.',
  'Import {what} from Google Drive': 'استيراد {what} من Google Drive',
  'Scene Backdrop': 'خلفية المشهد',
  'Athlete Reference': 'صورة العارض المرجعية',
  'Apparel Gear': 'الملابس والمنتجات',
  'Upload Footwear / Gear': 'رفع الأحذية / المنتجات',

  // ── library ──────────────────────────────────────────────────────────────
  'Nothing matches these filters': 'لا شيء يطابق عوامل التصفية هذه',
  'Nothing in the Library yet': 'لا يوجد شيء في المكتبة بعد',
  'Try removing a filter or clearing the search.': 'جرّب إزالة أحد عوامل التصفية أو مسح البحث.',
  'Every image you generate in the Studio is saved here automatically.':
    'كل صورة تنشئها في الاستوديو تُحفظ هنا تلقائيًا.',
  'Search product, number, brand, colour, shot…': 'ابحث عن منتج أو رقم أو علامة أو لون أو لقطة…',
  'Generated image': 'صورة مُولَّدة',
  'Approved — click to withdraw': 'معتمد — اضغط لسحب الاعتماد',
  'Approve this render': 'اعتماد هذه الصورة',
  'Download the trimmed picture': 'تنزيل الصورة بعد القص',
  'Download full size': 'تنزيل بالحجم الكامل',
  'Confirm delete': 'تأكيد الحذف',
  Name: 'الاسم',
  Brand: 'العلامة التجارية',
  Colour: 'اللون',
  Description: 'الوصف',
  Number: 'الرقم',
  Source: 'المصدر',
  Shot: 'اللقطة',
  Provider: 'المزوّد',
  Model: 'النموذج',
  Quality: 'الجودة',
  Scene: 'المشهد',

  // ── product review — sorting narration ───────────────────────────────────
  'Reading angles…': 'جارٍ قراءة الزوايا…',
  'This pass only reads orientation — front, back, side — and never decides which photos match.':
    'هذه المرحلة تقرأ الاتجاه فقط — أمام، خلف، جانب — ولا تقرر أي الصور متطابقة.',
  'Trimming the backgrounds…': 'جارٍ قص الخلفيات…',
  'Cropping away the room means the product fills the frame, so fine details stay readable.':
    'قص المكان المحيط يجعل المنتج يملأ الإطار، فتبقى التفاصيل الدقيقة واضحة.',
  'Downloading the local image model…': 'جارٍ تنزيل نموذج الصور المحلي…',
  'Starting the download. One time only — it is cached for every folder after this.':
    'يبدأ التنزيل الآن. مرة واحدة فقط — ثم يُخزَّن مؤقتًا لكل مجلد بعد ذلك.',
  'This runs entirely on your machine, so the photos are never sent anywhere for this step.':
    'تُنفَّذ هذه الخطوة على جهازك بالكامل، فلا تُرسل الصور إلى أي مكان.',
  'Looking at the photos…': 'جارٍ فحص الصور…',
  'Each photo gets a visual fingerprint locally, to work out which ones are worth comparing.':
    'تحصل كل صورة على بصمة بصرية محليًا، لتحديد أي الصور تستحق المقارنة.',
  'Comparing photos side by side…': 'جارٍ مقارنة الصور جنبًا إلى جنب…',
  'Photos are laid out together and the model is asked which of them show the same item.':
    'تُعرض الصور معًا ويُسأل النموذج أيها يُظهر العنصر نفسه.',
  'Settling the close calls…': 'جارٍ حسم الحالات المتقاربة…',
  'A few pairs came back judged both ways. Each is asked again, on its own, by the other model.':
    'بعض الأزواج جاءت بحكمين متعارضين، ويُعاد سؤال كل زوج على حدة بالنموذج الآخر.',
  'Discard this folder': 'تجاهل هذا المجلد',
  'Close — the products stay': 'إغلاق — تبقى المنتجات',
  'Discard folder': 'تجاهل المجلد',
  Copied: 'تم النسخ',
  'Copy log': 'نسخ السجل',

  // ── product attributes — display labels ──────────────────────────────────
  Type: 'النوع',
  Subcategory: 'الفئة الفرعية',
  'Other colours': 'ألوان أخرى',
  Material: 'الخامة',
  Texture: 'الملمس',
  Finish: 'التشطيب',
  Pattern: 'النقش',
  Silhouette: 'القَصّة',
  Heel: 'الكعب',
  'Heel height': 'ارتفاع الكعب',
  Toe: 'المقدمة',
  Sole: 'النعل',
  'Sole thickness': 'سماكة النعل',
  Shaft: 'الساق',
  Closure: 'الإغلاق',
  Straps: 'الأحزمة',
  Stitching: 'الخياطة',
  'Sole colour': 'لون النعل',
  'Heel colour': 'لون الكعب',
  'Sole heel': 'كعب النعل',
  'Lace colour': 'لون الرباط',
  'Logo colour': 'لون الشعار',
  'Logo sits': 'موضع الشعار',
  Lining: 'البطانة',
  Collar: 'الياقة',
  Tongue: 'اللسان',
  Logo: 'الشعار',
  Code: 'الرمز',
  Size: 'المقاس',
  'not visible': 'غير ظاهر',
  code: 'رمز',
  sole: 'نعل',
  heel: 'كعب',
  'sole heel': 'كعب النعل',
  laces: 'أربطة',
  logo: 'شعار',
  'logo on': 'الشعار على',
  lining: 'بطانة',
  collar: 'ياقة',
  'heel type': 'نوع الكعب',
  toe: 'مقدمة',
  'sole type': 'نوع النعل',
  shaft: 'ساق',
  closure: 'إغلاق',
  size: 'مقاس',
  marks: 'علامات',
  Top: 'قطعة علوية',
  Bottoms: 'قطعة سفلية',
  Other: 'أخرى',

  // ── outfit builder ───────────────────────────────────────────────────────
  'Shirt / Top': 'قميص / قطعة علوية',
  'Pants / Bottoms': 'بنطال / قطعة سفلية',
  shirt: 'قميص',
  pants: 'بنطال',
  shoes: 'حذاء',
  manual: 'يدوي',
  'Picked up — click a line to place it. Esc to cancel.':
    'تم الالتقاط — اضغط على أحد الصفوف لوضعه. Esc للإلغاء.',
  '{label} — drag onto a line, or click to pick up':
    '{label} — اسحبه إلى أحد الصفوف، أو اضغط لالتقاطه',
  '{name} — drag to another line to move it': '{name} — اسحبه إلى صف آخر لنقله',
  '{label}: empty — this slot is rendered plain and unbranded':
    '{label}: فارغة — تُنشأ هذه الخانة بلا منتج وبلا علامة تجارية',
  'Remove {label} from {outfit}': 'إزالة {label} من {outfit}',
  'Drop to start this outfit': 'أفلت هنا لبدء هذا الطقم',
  'the manual upload': 'الرفع اليدوي',
  'the product': 'المنتج',
  'Drop a product anywhere on a line — it takes its own slot. Empty slots are rendered plain and unbranded. One image per outfit per shot.':
    'أفلت منتجًا في أي موضع على الصف — فيأخذ خانته الخاصة. تُنشأ الخانات الفارغة بلا علامة تجارية. صورة واحدة لكل طقم في كل لقطة.',

  // ── angle strip ──────────────────────────────────────────────────────────
  'More angles': 'زوايا إضافية',
  'Remove the {name} view': 'إزالة عرض {name}',
  'Add {name} view': 'إضافة عرض {name}',
  'Upload several photos at once — they fill the empty slots in order; drag any that landed wrong':
    'ارفع عدة صور دفعة واحدة — تملأ الخانات الفارغة بالترتيب؛ اسحب أي صورة وقعت في غير موضعها',
  'Naming the views…': 'جارٍ تسمية العروض…',
  'upload order': 'ترتيب الرفع',
  'The account’s prepaid credits are used up, so the views could not be named. Top the balance up in AI Studio; no model will answer until then.':
    'نفد الرصيد المدفوع مسبقًا للحساب، لذلك تعذّرت تسمية العروض. اشحن الرصيد في AI Studio؛ لن يستجيب أي نموذج قبل ذلك.',
  'The API refused on quota, so the views could not be named. A per-minute limit clears in about a minute; a daily cap clears at midnight Pacific.':
    'رفضت الواجهة الطلب بسبب الحصة، لذلك تعذّرت تسمية العروض. الحد الدقيقي ينتهي خلال دقيقة تقريبًا، والحد اليومي ينتهي منتصف الليل بتوقيت المحيط الهادئ.',
  'Google’s models are saturated right now, so the views could not be named. This one is temporary — upload the set again shortly.':
    'نماذج Google مزدحمة حاليًا، لذلك تعذّرت تسمية العروض. هذه حالة مؤقتة — أعد رفع المجموعة بعد قليل.',
  'The analysis model this build asks for is not available to this key, so the views could not be named. This is a code fix, not an account problem.':
    'نموذج التحليل الذي تطلبه هذه النسخة غير متاح لهذا المفتاح، لذلك تعذّرت تسمية العروض. هذه مشكلة في الكود وليست في الحساب.',
  'The API refused the request itself, so the views could not be named. That is a bug in this build rather than an account problem.':
    'رفضت الواجهة الطلب نفسه، لذلك تعذّرت تسمية العروض. هذا خلل في هذه النسخة وليس مشكلة في الحساب.',
  'No answer came back in time, so the views could not be named.':
    'لم يصل أي رد في الوقت المحدد، لذلك تعذّرت تسمية العروض.',
  'A model answered, but not with a grouping that could be read, so the views were not named.':
    'ردّ أحد النماذج، لكن بتجميع غير قابل للقراءة، لذلك لم تُسمَّ العروض.',
  'The classifier could not be reached, so the views were not named.':
    'تعذّر الوصول إلى المصنِّف، لذلك لم تُسمَّ العروض.',

  // ── drive picker and header ──────────────────────────────────────────────
  'Connecting to Google...': 'جارٍ الاتصال بـ Google...',
  'Sign in with Google Drive': 'تسجيل الدخول عبر Google Drive',
  'Google User': 'مستخدم Google',
  'Only see "Google AI Studio" or missing folders?':
    'لا ترى سوى "Google AI Studio" أو تنقصك مجلدات؟',
  'Tap to open folder': 'اضغط لفتح المجلد',
  Photo: 'صورة',
  'photo generated': 'صورة تم إنشاؤها',
  'photos generated': 'صورة تم إنشاؤها',

  // ── folder upload and drive ──────────────────────────────────────────────
  'Upload a product folder': 'رفع مجلد منتجات',
  'Reading folder… {done}/{total}': 'جارٍ قراءة المجلد… {done}/{total}',
  'That folder has no images in it.': 'هذا المجلد لا يحتوي على أي صور.',
  'Could not read that folder.': 'تعذّرت قراءة هذا المجلد.',
  'Downscaling each photo for the render and for naming its view.':
    'جارٍ تصغير كل صورة للإنشاء ولتسمية زاويتها.',
  'One subfolder per product, each holding that product\'s angle photos. Up to {max} images.':
    'مجلد فرعي لكل منتج، يحتوي على صور زواياه. حتى {max} صورة.',
  'My Drive': 'ملفاتي',
  'Try switching to the "All Photos (Entire Drive)" tab above, check "Shared with Me", or upload images to Google Drive.':
    'جرّب التبديل إلى تبويب "كل الصور (Drive بالكامل)" بالأعلى، أو تحقق من "مشارَك معي"، أو ارفع صورًا إلى Google Drive.',

  // ── titles reached through a variable ──────────────────────────────────────
  'Select Image from Google Drive': 'اختر صورة من Google Drive',

  // ── side-evidence guard and apparel side slots ───────────────────────────
  'Shirt / top — front, back and both sides of the same garment':
    'القميص / القطعة العلوية — الأمام والخلف والجانبان لنفس القطعة',
  'Pants / bottoms — front, back and both sides of the same garment':
    'البنطال / القطعة السفلية — الأمام والخلف والجانبان لنفس القطعة',
  'Cannot generate {shots} — this view needs a {need} photograph of {products}. Add it in that product’s angle strip, then generate again.':
    'تعذّر إنشاء {shots} — يحتاج هذا العرض إلى صورة {need} للمنتج {products}. أضفها في شريط زوايا ذلك المنتج ثم أعد الإنشاء.',
};
