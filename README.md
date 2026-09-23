# 북토끼 로컬 실행

프레임워크나 npm 설치가 필요 없는 정적 웹앱입니다. 책과 표지 이미지 원본은 현재 브라우저의 IndexedDB에 저장됩니다.

## 실행 방법 (macOS)

1. 터미널 앱을 엽니다.
2. `cd `를 입력한 다음 Finder에서 이 프로젝트 폴더를 터미널로 끌어 놓고 Enter를 누릅니다.
3. 아래 명령을 실행합니다.

```sh
python3 dev_server.py
```

4. 터미널을 켜 둔 상태로 브라우저에서 <http://localhost:8000>을 엽니다.
5. 종료하려면 터미널에서 Control + C를 누릅니다. 다시 사용할 때 같은 명령으로 실행합니다.

Python 3가 필요합니다. 이 컴퓨터의 기본 `python3`를 사용할 수 없다면 Codex에서 제공하는 Python으로 다음 명령을 실행할 수 있습니다.

```sh
/Users/yunz/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 dev_server.py
```

`dev_server.py`는 현재 프로젝트 폴더만 제공하고 브라우저 캐시를 사용하지 않도록 설정되어 있습니다.

## Supabase Kakao 로그인 설정

`auth-config.js`에 Supabase Dashboard의 공개 브라우저 설정값을 입력합니다.

```js
window.BOOKTOKKI_AUTH_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_PUBLISHABLE_OR_ANON_KEY"
};
```

- Project URL: Supabase Dashboard의 **Project Settings → API → Project URL**
- Publishable/anon key: 같은 화면의 **Publishable key** 또는 legacy **anon public key**
- `service_role` key, DB password, Kakao REST API key, Kakao Client Secret은 이 파일에 넣지 않습니다.

Supabase Dashboard의 **Authentication → URL Configuration**에서 다음 redirect URL을 허용해야 합니다.

- `https://rhthgus2660.github.io/booktokki/`
- `http://localhost:8000/`

로컬에서도 `python3 dev_server.py` 실행 후 `http://localhost:8000/` 주소만 사용합니다.

## GitHub Pages와 홈 화면 실행

이 프로젝트는 빌드 과정 없이 저장소 루트를 GitHub Pages로 배포할 수 있습니다. 배포 URL을 스마트폰 브라우저에서 연 뒤 iPhone은 공유 메뉴의 `홈 화면에 추가`, Android Chrome은 브라우저 메뉴의 `앱 설치` 또는 `홈 화면에 추가`를 사용합니다. 설치된 아이콘으로 실행하면 standalone 화면으로 열립니다.

앱 데이터는 URL과 브라우저별 IndexedDB에 저장됩니다. `http://localhost:8000`의 데이터는 GitHub Pages의 HTTPS URL로 자동 이동하지 않으며, 도메인을 바꾸거나 사이트 데이터를 삭제하면 기존 기록에 접근할 수 없습니다. 실사용 기록을 시작한 뒤에는 같은 배포 URL과 홈 화면 아이콘을 계속 사용하세요.

## 저장 복원 확인

1. 제목, 저자, 전체 페이지와 표지 이미지를 입력해 책을 추가합니다.
2. 책 상세 화면에서 현재 페이지를 변경하고 북로그를 작성합니다.
3. 새로고침해서 책, 페이지, 진행률, 북로그와 표지가 유지되는지 확인합니다.
4. “다 읽었어!”를 누르고 확인 후 새로고침해 완독 상태와 책장의 귀 책갈피를 확인합니다.
5. 독서 통계에서 오늘의 페이지 기록과 완독 권수를 확인합니다.
6. 표지를 변경하고 다시 새로고침해서 변경한 표지가 유지되는지 확인합니다.

항상 같은 브라우저·프로필과 `http://localhost:8000` 주소를 사용하세요. `127.0.0.1`, 다른 포트 또는 다른 브라우저는 별도 저장소를 사용합니다. 비공개 모드나 브라우저 사이트 데이터 삭제 시 기록이 없어질 수 있습니다. 로컬 서버를 끄는 것만으로는 기록이 삭제되지 않습니다. 여러 탭을 동시에 편집하면 마지막 저장이 반영되므로 한 탭에서 사용하세요.

Claude에 저장했던 기존 기록은 이 폴더에 포함되어 있지 않습니다. 이번 변경은 로컬에서 새로 작성한 기록을 저장하며, 기존 Claude 데이터를 자동으로 가져오지는 않습니다. 토끼 이미지는 로컬 파일이고 Google Fonts 글꼴은 인터넷 연결이 필요합니다. 연결이 없으면 대체 글꼴을 사용합니다.
