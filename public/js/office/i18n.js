// 사무실 렌더러 문구 사전(ko/en/zh/ja). 모르는 언어는 en, 지정하지 않으면 ko.

export const LANGS = ['ko', 'en', 'zh', 'ja'];

/** 'ko-KR', 'zh_CN', 'JA' → ko/zh/ja, 모르면 en. 빈 값이면 ko(하위 호환) */
export function normLang(lang) {
  if (lang == null || lang === '') return 'ko';
  const b = String(lang).toLowerCase().split(/[-_]/)[0];
  return LANGS.includes(b) ? b : 'en';
}

const DICT = {
  ko: {
    'zone.shelf': '자료실', 'zone.search': '정보검색실', 'zone.lounge': '휴게실', 'zone.meeting': '회의실', 'zone.server': '서버실', 'zone.dev': '개발실',
    'bub.carry': '전달', 'bub.tool': '도구', 'bub.searching': '검색 중', 'bub.reading': '읽는 중', 'bub.running': '실행 중',
    'bub.waiting': '승인 필요', 'bub.error': '오류', 'bub.done': '완료', 'bub.paused': '일시정지', 'bub.received': '받음', 'bub.leave': '퇴근',
    'misc.papers': '서류', 'misc.helper': '서브에이전트', 'misc.helperChip': '서브',
    'ui.office': '오피스 크루 사무실 화면', 'ui.zoomIn': '확대', 'ui.zoomOut': '축소', 'ui.fit': '화면 맞춤',
    'st.idle': '대기', 'st.thinking': '생각 중', 'st.typing': '입력 중', 'st.tool': '도구 사용', 'st.searching': '검색 중', 'st.reading': '읽는 중',
    'st.running': '실행 중', 'st.waiting': '승인 대기', 'st.error': '오류', 'st.done': '완료', 'st.paused': '일시정지', 'st.offline': '오프라인',
    'ed.spot.search': '정보검색실', 'ed.spot.shelf': '자료실', 'ed.spot.server': '서버실', 'ed.spot.meeting': '회의실', 'ed.spot.lounge': '휴게실', 'ed.spot.door': '입구',
    'ed.optional': '(선택)', 'ed.listSep': '·',
    'ed.errImage': '이미지를 읽지 못했어', 'ed.errFile': '파일을 읽지 못했어', 'ed.errSize': '이미지 크기를 알 수 없어',
    'ed.defaultName': '내 사무실', 'ed.namePh': '스킨 이름', 'ed.pick': '🖼 이미지 선택', 'ed.deskMode': '🪑 책상 찍기', 'ed.charSize': '캐릭터 크기',
    'ed.cancel': '취소', 'ed.save': '저장', 'ed.markerTip': '드래그: 이동 · 우클릭: 삭제',
    'ed.hintEmpty': '배경 이미지를 고르거나, 이 칸에 끌어다 놓거나, 붙여넣기(Ctrl+V) 해.',
    'ed.hintDesk': '이미지를 클릭하면 책상(캐릭터 자리)이 추가돼. 번호 순서대로 에이전트가 앉아. 최대 {max}개 · 드래그로 이동 · 우클릭으로 삭제.',
    'ed.hintSpot': '이미지를 클릭해서 "{label}" 위치를 정해. 다시 클릭하면 옮겨져.',
    'ed.dropHere': '여기에 이미지를 끌어다 놓거나 붙여넣기', 'ed.formats': 'PNG·JPG·WEBP, 큰 이미지는 2048px로 줄여서 저장해', 'ed.bgAlt': '스킨 배경',
    'ed.desks': '책상 {n}/{max}', 'ed.spots': '특수 위치 {n}/{m}', 'ed.imageSize': '이미지 {w}×{h}', 'ed.noImage': '이미지 없음',
    'ed.maxDesks': '책상은 최대 {max}개까지야.', 'ed.loading': '이미지 읽는 중…', 'ed.onlyImage': '이미지 파일만 쓸 수 있어.',
    'ed.needImage': '배경 이미지를 먼저 넣어줘.', 'ed.needDesk': '책상 위치를 1개 이상 찍어줘.',
    'ed.missingSpots': '{list} 위치가 없어. 그 상태의 에이전트는 자기 자리에서 일해. 그래도 저장하려면 한 번 더 눌러.',
  },
  en: {
    'zone.shelf': 'Library', 'zone.search': 'Research', 'zone.lounge': 'Lounge', 'zone.meeting': 'Meeting Room', 'zone.server': 'Server Room', 'zone.dev': 'Dev Room',
    'bub.carry': 'Handing off', 'bub.tool': 'Tool', 'bub.searching': 'Searching', 'bub.reading': 'Reading', 'bub.running': 'Running',
    'bub.waiting': 'Needs approval', 'bub.error': 'Error', 'bub.done': 'Done', 'bub.paused': 'Paused', 'bub.received': 'Received', 'bub.leave': 'Heading out',
    'misc.papers': 'Documents', 'misc.helper': 'Sub-agent', 'misc.helperChip': 'Sub',
    'ui.office': 'Office Crew office view', 'ui.zoomIn': 'Zoom in', 'ui.zoomOut': 'Zoom out', 'ui.fit': 'Fit to view',
    'st.idle': 'Idle', 'st.thinking': 'Thinking', 'st.typing': 'Typing', 'st.tool': 'Using a tool', 'st.searching': 'Searching', 'st.reading': 'Reading',
    'st.running': 'Running', 'st.waiting': 'Awaiting approval', 'st.error': 'Error', 'st.done': 'Done', 'st.paused': 'Paused', 'st.offline': 'Offline',
    'ed.spot.search': 'Research', 'ed.spot.shelf': 'Library', 'ed.spot.server': 'Server Room', 'ed.spot.meeting': 'Meeting Room', 'ed.spot.lounge': 'Lounge', 'ed.spot.door': 'Entrance',
    'ed.optional': '(optional)', 'ed.listSep': ', ',
    'ed.errImage': "Couldn't read the image", 'ed.errFile': "Couldn't read the file", 'ed.errSize': "Couldn't determine the image size",
    'ed.defaultName': 'My Office', 'ed.namePh': 'Skin name', 'ed.pick': '🖼 Choose image', 'ed.deskMode': '🪑 Place desks', 'ed.charSize': 'Character size',
    'ed.cancel': 'Cancel', 'ed.save': 'Save', 'ed.markerTip': 'Drag to move · Right-click to delete',
    'ed.hintEmpty': 'Choose a background image, drop one here, or paste it (Ctrl+V).',
    'ed.hintDesk': 'Click the image to add a desk (where a character sits). Agents take desks in number order. Up to {max} · drag to move · right-click to delete.',
    'ed.hintSpot': 'Click the image to set the "{label}" spot. Click again to move it.',
    'ed.dropHere': 'Drop or paste an image here', 'ed.formats': 'PNG · JPG · WEBP — large images are scaled down to 2048px', 'ed.bgAlt': 'Skin background',
    'ed.desks': 'Desks {n}/{max}', 'ed.spots': 'Special spots {n}/{m}', 'ed.imageSize': 'Image {w}×{h}', 'ed.noImage': 'No image',
    'ed.maxDesks': 'You can place up to {max} desks.', 'ed.loading': 'Loading image…', 'ed.onlyImage': 'Only image files are supported.',
    'ed.needImage': 'Add a background image first.', 'ed.needDesk': 'Place at least one desk.',
    'ed.missingSpots': 'No spot set for {list}. Agents in those states will work at their desks. Click Save again to save anyway.',
  },
  zh: {
    'zone.shelf': '资料室', 'zone.search': '信息检索室', 'zone.lounge': '休息室', 'zone.meeting': '会议室', 'zone.server': '机房', 'zone.dev': '开发室',
    'bub.carry': '递交中', 'bub.tool': '工具', 'bub.searching': '搜索中', 'bub.reading': '阅读中', 'bub.running': '运行中',
    'bub.waiting': '需要批准', 'bub.error': '出错', 'bub.done': '完成', 'bub.paused': '已暂停', 'bub.received': '已收到', 'bub.leave': '下班',
    'misc.papers': '文件', 'misc.helper': '子智能体', 'misc.helperChip': '子',
    'ui.office': 'Office Crew 办公室视图', 'ui.zoomIn': '放大', 'ui.zoomOut': '缩小', 'ui.fit': '适应窗口',
    'st.idle': '空闲', 'st.thinking': '思考中', 'st.typing': '输入中', 'st.tool': '使用工具', 'st.searching': '搜索中', 'st.reading': '阅读中',
    'st.running': '运行中', 'st.waiting': '等待批准', 'st.error': '出错', 'st.done': '完成', 'st.paused': '已暂停', 'st.offline': '离线',
    'ed.spot.search': '信息检索室', 'ed.spot.shelf': '资料室', 'ed.spot.server': '机房', 'ed.spot.meeting': '会议室', 'ed.spot.lounge': '休息室', 'ed.spot.door': '入口',
    'ed.optional': '(可选)', 'ed.listSep': '、',
    'ed.errImage': '无法读取图片', 'ed.errFile': '无法读取文件', 'ed.errSize': '无法获取图片尺寸',
    'ed.defaultName': '我的办公室', 'ed.namePh': '皮肤名称', 'ed.pick': '🖼 选择图片', 'ed.deskMode': '🪑 放置工位', 'ed.charSize': '角色大小',
    'ed.cancel': '取消', 'ed.save': '保存', 'ed.markerTip': '拖动:移动 · 右键:删除',
    'ed.hintEmpty': '选择背景图片,或拖放到此处,也可以直接粘贴(Ctrl+V)。',
    'ed.hintDesk': '点击图片即可添加工位(角色的座位)。智能体按编号顺序就座。最多 {max} 个 · 拖动可移动 · 右键可删除。',
    'ed.hintSpot': '点击图片设置“{label}”的位置。再次点击可移动。',
    'ed.dropHere': '将图片拖放或粘贴到这里', 'ed.formats': 'PNG·JPG·WEBP,大图会缩小到 2048px 后保存', 'ed.bgAlt': '皮肤背景',
    'ed.desks': '工位 {n}/{max}', 'ed.spots': '特殊位置 {n}/{m}', 'ed.imageSize': '图片 {w}×{h}', 'ed.noImage': '暂无图片',
    'ed.maxDesks': '最多只能放置 {max} 个工位。', 'ed.loading': '正在读取图片…', 'ed.onlyImage': '只支持图片文件。',
    'ed.needImage': '请先添加背景图片。', 'ed.needDesk': '请至少放置一个工位。',
    'ed.missingSpots': '尚未设置{list}的位置。处于这些状态的智能体会在自己的工位工作。如仍要保存,请再点一次保存。',
  },
  ja: {
    'zone.shelf': '資料室', 'zone.search': '情報検索室', 'zone.lounge': '休憩室', 'zone.meeting': '会議室', 'zone.server': 'サーバー室', 'zone.dev': '開発室',
    'bub.carry': '受け渡し中', 'bub.tool': 'ツール', 'bub.searching': '検索中', 'bub.reading': '閲覧中', 'bub.running': '実行中',
    'bub.waiting': '承認が必要', 'bub.error': 'エラー', 'bub.done': '完了', 'bub.paused': '一時停止', 'bub.received': '受け取り', 'bub.leave': '退勤',
    'misc.papers': '書類', 'misc.helper': 'サブエージェント', 'misc.helperChip': 'サブ',
    'ui.office': 'Office Crew オフィス画面', 'ui.zoomIn': '拡大', 'ui.zoomOut': '縮小', 'ui.fit': '全体表示',
    'st.idle': '待機中', 'st.thinking': '思考中', 'st.typing': '入力中', 'st.tool': 'ツール使用中', 'st.searching': '検索中', 'st.reading': '閲覧中',
    'st.running': '実行中', 'st.waiting': '承認待ち', 'st.error': 'エラー', 'st.done': '完了', 'st.paused': '一時停止', 'st.offline': 'オフライン',
    'ed.spot.search': '情報検索室', 'ed.spot.shelf': '資料室', 'ed.spot.server': 'サーバー室', 'ed.spot.meeting': '会議室', 'ed.spot.lounge': '休憩室', 'ed.spot.door': '入口',
    'ed.optional': '(任意)', 'ed.listSep': '・',
    'ed.errImage': '画像を読み込めませんでした', 'ed.errFile': 'ファイルを読み込めませんでした', 'ed.errSize': '画像サイズを取得できませんでした',
    'ed.defaultName': 'マイオフィス', 'ed.namePh': 'スキン名', 'ed.pick': '🖼 画像を選択', 'ed.deskMode': '🪑 デスクを配置', 'ed.charSize': 'キャラクターの大きさ',
    'ed.cancel': 'キャンセル', 'ed.save': '保存', 'ed.markerTip': 'ドラッグで移動・右クリックで削除',
    'ed.hintEmpty': '背景画像を選ぶか、ここにドロップするか、貼り付け(Ctrl+V)てください。',
    'ed.hintDesk': '画像をクリックするとデスク(キャラクターの席)を追加します。エージェントは番号順に座ります。最大{max}個・ドラッグで移動・右クリックで削除。',
    'ed.hintSpot': '画像をクリックして「{label}」の位置を決めます。もう一度クリックすると移動します。',
    'ed.dropHere': 'ここに画像をドロップまたは貼り付け', 'ed.formats': 'PNG・JPG・WEBP、大きな画像は2048pxに縮小して保存します', 'ed.bgAlt': 'スキン背景',
    'ed.desks': 'デスク {n}/{max}', 'ed.spots': '特別な位置 {n}/{m}', 'ed.imageSize': '画像 {w}×{h}', 'ed.noImage': '画像なし',
    'ed.maxDesks': 'デスクは最大{max}個までです。', 'ed.loading': '画像を読み込み中…', 'ed.onlyImage': '画像ファイルのみ使用できます。',
    'ed.needImage': '先に背景画像を追加してください。', 'ed.needDesk': 'デスクを1つ以上配置してください。',
    'ed.missingSpots': '{list}の位置が未設定です。その状態のエージェントは自席で作業します。それでも保存する場合は、もう一度保存を押してください。',
  },
};

/** 문구 찾기. vars 의 {name} 자리를 채움. 없는 키는 en → 키 그대로 */
export function tr(lang, key, vars) {
  const d = DICT[lang] || DICT.en;
  let s = d[key] ?? DICT.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}
